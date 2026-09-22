/**
 * Tier 1 of the retrieval capability: search, scrape, map.
 *
 * These are the tools a planner reaches for on an ordinary field — one where
 * the answer is on a page that can simply be read. The tiers above them are
 * `firecrawl-agent.ts` (hand a multi-source question to Firecrawl's hosted
 * research agent) and `../agents/browser.ts` (drive a page that only yields its
 * data after interaction).
 *
 * Two rules shape every tool here.
 *
 * **No tool contains a query.** The query is an input the caller generates from
 * the field it is trying to fill. A tool that carried `${company} pricing`
 * inside it would decide, once and for all rows, what "pricing" means; the
 * point of making retrieval a tool is that the decision moves to the agent, per
 * field, per row.
 *
 * **No single call can flood the context.** Firecrawl returns whole pages, and
 * one long documentation page is larger than the budget for a whole enrichment
 * run. Every result is trimmed here in `execute`, to the budgets below, before
 * it leaves the tool.
 *
 * ### Why trim in `execute` rather than in `toModelOutput`
 *
 * `@mastra/core` 1.67.0 does support the hook: `ToolAction.toModelOutput`
 * (`dist/tools/types.d.ts`) is applied at runtime to a successful tool result
 * (`dist/agent-Dk0N0Nlg.js`, "if (tool?.toModelOutput && toolCall.result !=
 * null)"). It is deliberately not used. `toModelOutput` bounds only the copy
 * handed to the model; the untrimmed result still travels through the tool
 * stream, the trace, and storage, which is where a 500 KB scrape actually
 * hurts. Trimming in `execute` bounds all of them at once, and it makes the cap
 * part of the tool's contract — the output schema carries the `truncated` flag
 * that says it happened — instead of an invisible transform. Should a later
 * consumer need the untrimmed document, that is the moment to add
 * `toModelOutput` and widen the schema, not before.
 */
import { createTool } from '@mastra/core/tools';
import type { Document, SearchRequest } from 'firecrawl';
import { z } from 'zod';

import {
  firecrawlClient,
  isSslError,
  reportProgress,
  withFirecrawlRetry,
  type ProgressWriter,
} from './firecrawl-client';
import { BLOCKED_DOMAINS_LABEL, isBlockedUrl, splitBlocked } from './filters';

/**
 * Total characters of page text a single search call may return.
 *
 * Split evenly across the results it kept, so a ten-result search cannot spend
 * the whole budget on the first hit. Roughly 2k tokens.
 */
const SEARCH_CONTENT_BUDGET = 8_000;

/** Characters of markdown a single scrape may return; roughly 10k tokens. */
const SCRAPE_MARKDOWN_BUDGET = 40_000;

/** Links a single map call may return. */
const MAP_LINK_BUDGET = 200;

/** Milliseconds a scrape may spend inside Firecrawl before it gives up. */
const SCRAPE_TIMEOUT_MS = 30_000;

/**
 * The v4 SDK types a `search()` web result as `SearchResultWeb | Document`, but
 * when `scrapeOptions` is set the API merges the two shapes onto one object and
 * neither declared type covers the union. Same workaround as
 * `lib/services/firecrawl.ts`.
 */
interface SearchWebItem {
  url?: string;
  title?: string;
  description?: string;
  markdown?: string;
  metadata?: { url?: string; sourceURL?: string; title?: string; description?: string };
}

/** Cut `text` to `budget` characters, reporting whether anything was dropped. */
function trim(text: string | undefined, budget: number): { text: string; truncated: boolean } {
  if (!text) return { text: '', truncated: false };
  if (text.length <= budget) return { text, truncated: false };

  return { text: text.slice(0, budget), truncated: true };
}

const searchResultSchema = z.object({
  url: z.string(),
  title: z.string(),
  description: z.string(),
  markdown: z.string().describe('Page text, trimmed to this call’s share of the budget.'),
  truncated: z.boolean().describe('True when this page was cut short.'),
});

export const searchTool = createTool({
  id: 'firecrawl-search',
  description: [
    'Search the web and read the pages that come back.',
    'Write the query yourself from the fact you are trying to establish — there is no default query.',
    `Results on ${BLOCKED_DOMAINS_LABEL} are dropped and counted, never returned.`,
  ].join(' '),
  inputSchema: z.object({
    query: z.string().min(1).describe('The search query. Generate it for the field you are filling.'),
    limit: z.number().int().min(1).max(10).optional().describe('How many results to read. Default 5.'),
    scrapeContent: z
      .boolean()
      .optional()
      .describe('Read each result page, not just its snippet. Default true. Set false to save credits.'),
  }),
  outputSchema: z.object({
    query: z.string(),
    results: z.array(searchResultSchema),
    blockedCount: z.number().describe('Results dropped because they were on a blocked domain.'),
    truncated: z.boolean().describe('True when any result was cut short.'),
  }),
  execute: async ({ query, limit, scrapeContent }, { abortSignal, writer }) => {
    const client = firecrawlClient();
    const request: Omit<SearchRequest, 'query'> = { limit: limit ?? 5 };

    if (scrapeContent ?? true) {
      request.scrapeOptions = { formats: ['markdown'] };
    }

    await reportProgress(writer as ProgressWriter | undefined, `Searching the web for: ${query}`);

    const response = await withFirecrawlRetry(() => client.search(query, request), {
      signal: abortSignal,
      label: `search "${query}"`,
    });

    const items = (response.web ?? []) as SearchWebItem[];
    const mapped = items.map((item) => ({
      url: item.url || item.metadata?.url || item.metadata?.sourceURL || '',
      title: item.title || item.metadata?.title || '',
      description: item.description || item.metadata?.description || '',
      markdown: item.markdown,
    }));

    const { allowed, blocked } = splitBlocked(mapped, (item) => item.url);

    // Share the budget evenly rather than first-come-first-served: the top hit
    // is often the longest page, and letting it eat the whole allowance would
    // hide every corroborating source behind it.
    const perResult = Math.max(1, Math.floor(SEARCH_CONTENT_BUDGET / Math.max(1, allowed.length)));

    const results = [];
    for (const item of allowed) {
      const { text, truncated } = trim(item.markdown, perResult);
      results.push({ ...item, markdown: text, truncated });
      await reportProgress(
        writer as ProgressWriter | undefined,
        item.title ? `Read: ${item.title}` : 'Read a search result',
        item.url
      );
    }

    return {
      query,
      results,
      blockedCount: blocked.length,
      truncated: results.some((result) => result.truncated),
    };
  },
});

export const scrapeTool = createTool({
  id: 'firecrawl-scrape',
  description: [
    'Read one page as markdown.',
    'Use it when you already know which url holds the fact.',
    `A url on ${BLOCKED_DOMAINS_LABEL} resolves as blocked with a reason instead of being fetched.`,
  ].join(' '),
  inputSchema: z.object({
    url: z.string().min(1).describe('The page to read. A missing scheme is treated as https.'),
  }),
  outputSchema: z.object({
    url: z.string().describe('The url that was requested.'),
    blocked: z.boolean().describe('True when the url was refused rather than fetched.'),
    reason: z.string().optional().describe('Why a blocked url was refused.'),
    title: z.string().optional(),
    markdown: z.string(),
    truncated: z.boolean().describe('True when the page was cut short.'),
  }),
  execute: async ({ url }, { abortSignal, writer }) => {
    const target = url.startsWith('http') ? url : `https://${url}`;

    if (isBlockedUrl(target)) {
      const reason = `${target} is on a blocked domain (${BLOCKED_DOMAINS_LABEL}); its public pages are login walls, so treat this source as unavailable rather than working around it.`;
      await reportProgress(writer as ProgressWriter | undefined, reason, target);

      return { url: target, blocked: true, reason, markdown: '', truncated: false };
    }

    const client = firecrawlClient();
    await reportProgress(writer as ProgressWriter | undefined, `Reading ${target}`, target);

    const document = await withFirecrawlRetry<Document>(
      async (attempt) => {
        try {
          return await client.scrape(target, { formats: ['markdown'], timeout: SCRAPE_TIMEOUT_MS });
        } catch (error) {
          // Ported from `FirecrawlService.scrapeUrl`: a certificate failure is
          // retried exactly once with verification relaxed, and only on the
          // first attempt, so a site with a genuinely broken chain costs one
          // extra request rather than one per backoff step.
          if (!isSslError(error) || attempt > 0) throw error;

          console.warn(`SSL error for ${target}, retrying with skipTlsVerification...`);
          return await client.scrape(target, {
            formats: ['markdown'],
            skipTlsVerification: true,
            timeout: SCRAPE_TIMEOUT_MS,
          });
        }
      },
      { signal: abortSignal, label: `scrape ${target}` }
    );

    const { text, truncated } = trim(document.markdown, SCRAPE_MARKDOWN_BUDGET);

    return {
      url: target,
      blocked: false,
      title: document.metadata?.title,
      markdown: text,
      truncated,
    };
  },
});

export const mapTool = createTool({
  id: 'firecrawl-map',
  description: [
    'List the urls on a site, so you can pick the page worth reading instead of guessing at one.',
    'Pass `search` to keep only urls whose path or title matches a word you choose.',
    'Returns urls only — follow up with firecrawl-scrape to read one.',
  ].join(' '),
  inputSchema: z.object({
    url: z.string().min(1).describe('Root url of the site to map.'),
    search: z
      .string()
      .optional()
      .describe('Keep only urls matching this term. Generate it from the field you are filling.'),
    limit: z.number().int().min(1).max(MAP_LINK_BUDGET).optional().describe('Max urls. Default 100.'),
  }),
  outputSchema: z.object({
    url: z.string(),
    links: z.array(z.object({ url: z.string(), title: z.string().optional() })),
    blockedCount: z.number().describe('Urls dropped because they were on a blocked domain.'),
    truncated: z.boolean().describe('True when the site has more urls than were returned.'),
  }),
  execute: async ({ url, search, limit }, { abortSignal, writer }) => {
    const target = url.startsWith('http') ? url : `https://${url}`;
    const cap = Math.min(limit ?? 100, MAP_LINK_BUDGET);

    const client = firecrawlClient();
    await reportProgress(
      writer as ProgressWriter | undefined,
      search ? `Mapping ${target} for "${search}"` : `Mapping ${target}`,
      target
    );

    const response = await withFirecrawlRetry(() => client.map(target, { search, limit: cap }), {
      signal: abortSignal,
      label: `map ${target}`,
    });

    const { allowed, blocked } = splitBlocked(response.links ?? [], (link) => link.url);
    const links = allowed.slice(0, cap).map((link) => ({ url: link.url, title: link.title }));

    return {
      url: target,
      links,
      blockedCount: blocked.length,
      truncated: allowed.length > links.length,
    };
  },
});
