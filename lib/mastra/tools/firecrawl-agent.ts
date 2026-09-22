/**
 * Tier 2 of the retrieval capability: Firecrawl's hosted research agent.
 *
 * Tier 1 (`firecrawl.ts`) answers a field that lives on *a* page. This tier is
 * for a field that only exists once several pages are read together — a funding
 * total spread across a press release and a filing, a headcount that has to be
 * reconciled between a careers page and an about page. Firecrawl runs that
 * multi-source loop server side and returns one object shaped by a JSON schema
 * the caller supplies, so the model here spends no context on the intermediate
 * pages.
 *
 * Like every tool in this directory it carries no query of its own: `prompt`,
 * `urls` and `schema` all come from the caller.
 *
 * ### Why this starts and polls instead of calling the blocking `agent()`
 *
 * The 4.41.0 SDK does ship a blocking waiter — `Firecrawl.agent()`, which is
 * `startAgent()` followed by `waitAgent()` (`dist/index.js`). It is not used,
 * for one reason: `waitAgent` takes no `AbortSignal`, and because it never
 * surfaces the job id to its caller, an aborted run could neither stop waiting
 * nor stop the job. A hosted agent run is the most expensive call in this
 * codebase, so a cancelled enrichment has to actually cancel it. Starting the
 * job here keeps the id, which makes both possible: the poll loop below sleeps
 * abortably, and an abort calls {@link Firecrawl.cancelAgent} on the way out.
 * That method does exist at 4.41.0 (`cancelAgent(jobId): Promise<boolean>` in
 * `dist/index.d.ts`), so the remote job is stopped rather than left billing.
 *
 * The polling interval matches the spec (3s) rather than the SDK's 2s default.
 */
import { createTool } from '@mastra/core/tools';
import type { AgentStatusResponse } from 'firecrawl';
import { z } from 'zod';

import {
  delay,
  firecrawlClient,
  reportProgress,
  withFirecrawlRetry,
  type ProgressWriter,
} from './firecrawl-client';
import { isBlockedUrl } from './filters';

/** How often the job's status is checked. */
const POLL_INTERVAL_MS = 3_000;

/** Matches an absolute http(s) url anywhere in a string. */
const URL_PATTERN = /https?:\/\/[^\s"'<>)\]}]+/g;

/**
 * Collect every source url the run can be attributed to.
 *
 * `AgentStatusResponse` declares no `sources` field at 4.41.0 — unlike
 * `ExtractResponse`, which does — so sources are assembled rather than read:
 * the urls the caller pinned, plus any `sources` the API happens to return
 * despite not declaring it, plus every absolute url that appears in the
 * returned data. That last part is what makes a citation possible at all when
 * the caller pinned no urls and let the agent find its own.
 *
 * Blocked domains are dropped here too, so a source the pipeline would refuse
 * to scrape is never offered as a citation either.
 */
function collectSources(status: AgentStatusResponse, urls: string[] | undefined): string[] {
  const found = new Set<string>();

  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || value == null) return;

    if (typeof value === 'string') {
      for (const match of value.match(URL_PATTERN) ?? []) found.add(match);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }

    if (typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) walk(item, depth + 1);
    }
  };

  for (const url of urls ?? []) found.add(url);
  walk((status as { sources?: unknown }).sources, 0);
  walk(status.data, 0);

  return [...found].filter((url) => !isBlockedUrl(url));
}

export const firecrawlAgentTool = createTool({
  id: 'firecrawl-agent',
  description: [
    "Hand a question to Firecrawl's hosted research agent when the answer has to be assembled from several pages.",
    'It searches, reads and reconciles server side, then returns one object matching the JSON schema you supply.',
    'Slower and more expensive than firecrawl-search — use it only when a single page cannot settle the question.',
  ].join(' '),
  inputSchema: z.object({
    prompt: z
      .string()
      .min(1)
      .describe('What to find out. Write it yourself from the field you are filling.'),
    urls: z
      .array(z.string())
      .optional()
      .describe('Pin the research to these pages. Omit to let the agent find its own sources.'),
    schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('JSON Schema for the object you want back. Omit for free-form data.'),
  }),
  outputSchema: z.object({
    status: z.enum(['completed', 'failed']).describe('An aborted run throws instead of resolving.'),
    data: z.unknown().describe('The object the agent produced, shaped by `schema` when one was given.'),
    sources: z.array(z.string()).describe('Urls this answer can be attributed to.'),
    error: z.string().optional().describe('Why the run failed, when it did.'),
  }),
  execute: async ({ prompt, urls, schema }, { abortSignal, writer }) => {
    const client = firecrawlClient();

    await reportProgress(
      writer as ProgressWriter | undefined,
      `Starting a Firecrawl research agent: ${prompt}`
    );

    const started = await withFirecrawlRetry(
      () => client.startAgent({ prompt, urls, schema }),
      { signal: abortSignal, label: 'startAgent' }
    );

    if (!started.success || !started.id) {
      throw new Error(`Firecrawl agent did not start: ${started.error ?? 'no job id returned'}`);
    }

    const jobId = started.id;

    try {
      for (;;) {
        abortSignal?.throwIfAborted();

        const status = await withFirecrawlRetry(() => client.getAgentStatus(jobId), {
          signal: abortSignal,
          label: `getAgentStatus ${jobId}`,
        });

        if (status.status !== 'processing') {
          const sources = collectSources(status, urls);

          for (const source of sources) {
            await reportProgress(writer as ProgressWriter | undefined, 'Agent source', source);
          }

          return {
            status: status.status === 'completed' ? ('completed' as const) : ('failed' as const),
            data: status.data ?? null,
            sources,
            error: status.error,
          };
        }

        await reportProgress(writer as ProgressWriter | undefined, `Research agent ${jobId} is still working`);
        await delay(POLL_INTERVAL_MS, abortSignal);
      }
    } catch (error) {
      if (abortSignal?.aborted) {
        // Fire and forget: the caller is already gone, and failing to cancel
        // must not replace the abort reason with a network error.
        void Promise.resolve(client.cancelAgent(jobId)).catch(() => undefined);
      }
      throw error;
    }
  },
});
