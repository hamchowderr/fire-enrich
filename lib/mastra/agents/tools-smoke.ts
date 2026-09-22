/**
 * TEMPORARY tools smoke agent.
 *
 * It exists only so each Firecrawl tier can be exercised end to end from Studio
 * or the Mastra HTTP API before the research agent exists to call them: one
 * agent with all four tools attached, and instructions that push the model to
 * call exactly the tool it was asked for and nothing else.
 *
 * It is deliberately separate from `smoke.ts` rather than an extension of it.
 * `smoke` proves the model path with no tools at all, and `tests/routes/smoke.test.ts`
 * asserts it echoes verbatim; giving it tools would change what that test proves.
 *
 * DELETE THIS FILE when the research agent lands, and drop `toolsSmoke` from the
 * `agents` map in `lib/mastra/index.ts` at the same time.
 */
import { Agent } from '@mastra/core/agent';

import { resolveModel } from '../models';
import { firecrawlAgentTool } from '../tools/firecrawl-agent';
import { mapTool, scrapeTool, searchTool } from '../tools/firecrawl';

export const toolsSmokeAgent = new Agent({
  id: 'tools-smoke',
  name: 'Tools Smoke',
  description: 'Temporary agent used to exercise the Firecrawl tools one tier at a time.',
  instructions: [
    'You exist to prove the Firecrawl tools work. You have four:',
    '- firecrawl-search: search the web and read the results.',
    '- firecrawl-scrape: read one known url.',
    '- firecrawl-map: list the urls on a site.',
    '- firecrawl-agent: hand a multi-source question to Firecrawl’s hosted research agent.',
    '',
    'Call exactly the tool the user asks for, exactly once, then stop and report what came back.',
    'Write the query, url or prompt yourself from what the user asked. Never invent a second call to "check" the first.',
    'Report concretely: the urls you saw and the values you found. Do not summarise away the evidence.',
  ].join('\n'),
  model: resolveModel('research'),
  tools: {
    search: searchTool,
    scrape: scrapeTool,
    map: mapTool,
    firecrawlAgent: firecrawlAgentTool,
  },
});
