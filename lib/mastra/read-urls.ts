/**
 * Which urls a tool call actually read, from its successful result.
 *
 * The evidence rule (`mappers.ts` `checkFindings`) keeps a quote only when its
 * url was read in the same research group. "Read" is decided here, from the
 * `tool-result` chunks of the agent's stream, and never from the progress
 * events the tools write: those are written before the fetch, so a scrape that
 * 404s or times out would otherwise count as read and a quote invented for it
 * would survive.
 *
 * Results are recognised by shape rather than by tool name, because the name
 * the model sees is the key an agent registers the tool under:
 *
 * - search (`firecrawl-search`): `results[].url`, the pages whose text came back;
 * - scrape (`firecrawl-scrape`): `url` when `blocked` is false;
 * - hosted agent (`firecrawl-agent`): `sources` of a `completed` run;
 * - map (`firecrawl-map`): nothing. It returns a link list; no page was read.
 *
 * A sub-agent (`agent-*` tool) is read through its own tool results with the
 * same rules, plus the urls named in its answer text. The text is a weaker
 * signal than a tool result: the model can name a url it never opened. It is
 * accepted because a browser tool's result does not always carry the url it
 * navigated to, and the answer is where the sub-agent reports the page it read.
 */
import { isBlockedUrl } from './tools/filters';

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]}]+/g;

function urlsInText(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  return (text.match(URL_PATTERN) ?? []).map((match) => match.replace(/[.,;:]+$/, ''));
}

/** Urls a Firecrawl tool's successful output shows were read. */
function readByFirecrawlResult(result: unknown): string[] {
  if (typeof result !== 'object' || result === null) return [];
  const value = result as {
    results?: Array<{ url?: unknown }>;
    url?: unknown;
    blocked?: unknown;
    status?: unknown;
    sources?: unknown;
    links?: unknown;
  };

  // search
  if (Array.isArray(value.results)) {
    return value.results.map((item) => item?.url).filter((url): url is string => typeof url === 'string' && url.length > 0);
  }

  // hosted agent
  if (Array.isArray(value.sources) && typeof value.status === 'string') {
    return value.status === 'completed'
      ? value.sources.filter((url): url is string => typeof url === 'string')
      : [];
  }

  // map: a list of links, none of them read
  if (Array.isArray(value.links)) return [];

  // scrape (and any tool that reports the page it opened)
  if (typeof value.url === 'string' && value.blocked !== true) return [value.url];

  return [];
}

interface SubAgentToolResult {
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

/** Urls an `agent-*` sub-agent's result shows were read. */
function readBySubAgent(result: unknown): string[] {
  const { text, subAgentToolResults } = (result ?? {}) as {
    text?: unknown;
    subAgentToolResults?: SubAgentToolResult[];
  };

  const urls = [...urlsInText(text)];
  for (const toolResult of subAgentToolResults ?? []) {
    if (toolResult.isError) continue;
    urls.push(...readByFirecrawlResult(toolResult.result));
  }
  return urls;
}

/**
 * The urls one `tool-result` chunk payload shows were read, blocked domains
 * excluded. An error result read nothing.
 */
export function readUrlsFromToolResult(payload: {
  toolName?: string;
  result?: unknown;
  isError?: boolean;
}): string[] {
  if (payload.isError) return [];

  const urls = payload.toolName?.startsWith('agent-')
    ? readBySubAgent(payload.result)
    : readByFirecrawlResult(payload.result);

  return [...new Set(urls)].filter((url) => !isBlockedUrl(url));
}
