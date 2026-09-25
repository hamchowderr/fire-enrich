/**
 * Research agent: fills one research group's fields for one company.
 *
 * One generic agent serves every group of every plan. What differs per group
 * arrives with the call: the prompt (company context, fields, the plan's
 * queries, sources and evidence rules, rendered by the workflow) and the
 * group's strategy on the request context, which decides the tools:
 *
 * | strategy  | tools                                                        |
 * | --------- | ------------------------------------------------------------ |
 * | `search`  | firecrawl-search, firecrawl-scrape, firecrawl-map            |
 * | `agent`   | the above plus firecrawl-agent (Firecrawl's hosted agent)    |
 * | `browser` | the search tools plus the browser agent, as sub-agent tool   |
 * |           | `agent-browser`                                              |
 *
 * The browser agent is attached through the Agent `agents` option, which
 * `@mastra/core` 1.71 turns into a tool named `agent-<key>` for the model
 * (`Agent.listAgentTools` in `dist/agent-*.js`). It is resolved per call, so a
 * search or agent group never sees it and never provisions a browser session.
 *
 * ## Memory
 *
 * The browser agent refuses to track its page without a memory thread and
 * resource (see `browser.ts`). On 1.71 a sub-agent is given memory only when
 * its parent call carries both a thread and a resource and the sub-agent sets
 * no `memory` in its own default call options (`defaultOptions`; its `Memory`
 * instance does not count). The browser agent sets none, so browser-strategy
 * calls pass `memory: { thread: runId, resource: sessionId }`. Those ids switch
 * the injection on; they are not the sub-agent's own. The delegated run gets
 * a thread and resource of its own, derived by Mastra (`generateId`, or from
 * ids the model puts in the delegation call): in Studio they came out as
 * `<runId>-<uuid>` and `<sessionId>-browser`. Other strategies run without
 * memory. The agent always
 * carries a `Memory` because the `memory` call option needs one to act on.
 *
 * Output is requested by the caller as `structuredOutput: PhaseOutput`.
 */
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

import { resolveModel } from '../models';
import { firecrawlAgentTool } from '../tools/firecrawl-agent';
import { mapTool, scrapeTool, searchTool } from '../tools/firecrawl';
import { BLOCKED_DOMAINS_LABEL } from '../tools/filters';

import { browserAgent } from './browser';
import {
  RESEARCH_MODEL_KEY,
  RESEARCH_STRATEGY_KEY,
  type ResearchStrategy,
} from './research-context';

const SEARCH_TOOLS = { search: searchTool, scrape: scrapeTool, map: mapTool };

function strategyOf(requestContext: { get(key: string): unknown }): ResearchStrategy {
  const strategy = requestContext.get(RESEARCH_STRATEGY_KEY);
  return strategy === 'agent' || strategy === 'browser' ? strategy : 'search';
}

export const researchAgent = new Agent({
  id: 'research',
  name: 'Research',
  description:
    'Researches one group of fields for one company and reports each value with the page quotes that support it.',
  instructions: [
    'You research facts about one company for a data-enrichment table. The user message gives you the company, the fields to fill, the searches the plan suggests, the sources to prefer and what counts as evidence.',
    '',
    'How to work:',
    '- Use the tools to read pages. The suggested queries are a starting point; rewrite or add searches when they miss.',
    '- Prefer the sources the plan names. Read the page before you quote it.',
    '- Stop once every field has a supported value or you have run out of reasonable searches.',
    `- Never use ${BLOCKED_DOMAINS_LABEL} as a source.`,
    '',
    'Evidence rules — these are not negotiable:',
    '- Report a value only when a page you actually read in this task, with a tool, supports it. Its url goes in `evidence`, with the exact supporting text copied into `quote`.',
    '- A url you did not read, a url from memory, or a url you guessed is not evidence.',
    '- When nothing you read supports a value, report `value: null`, `confidence: 0`, empty `evidence`, and say what you tried in `notes`. Never invent, estimate or infer a value to avoid a null.',
    '- Set `sourcesAgree` to false when your sources disagree, and report the best-supported value.',
    '',
    'Return exactly one finding per field you were asked for, using the field `name` as given, and nothing for fields you were not asked for.',
  ].join('\n'),
  model: ({ requestContext }) => resolveModel('research', requestContext.get(RESEARCH_MODEL_KEY) as string | undefined),
  tools: ({ requestContext }) => {
    const strategy = strategyOf(requestContext);
    return strategy === 'agent' ? { ...SEARCH_TOOLS, firecrawlAgent: firecrawlAgentTool } : SEARCH_TOOLS;
  },
  agents: ({ requestContext }) =>
    strategyOf(requestContext) === 'browser' ? { browser: browserAgent } : {},
  memory: new Memory(),
});
