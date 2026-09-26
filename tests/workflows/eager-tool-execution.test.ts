/**
 * The research step under eager tool execution, which `@mastra/core` 1.71
 * turns on by default for `agent.stream()`: a tool starts as soon as its own
 * arguments are complete, while the model is still streaming the rest of the
 * step.
 *
 * One `enrichRow` run with two groups, every model call answered by AIMock
 * (`fixtures/research-eager.json`). In each group the model's first step calls
 * `search` and then `scrape`, streamed slowly (`latency`, `chunkSize`) so the
 * scrape arguments arrive well after the search arguments are complete:
 * - "Eager reads" then returns a valid answer citing one page from each tool.
 * - "Eager fallback" then returns text that is not JSON, so Mastra falls back.
 *
 * The tests check that eager execution really happened (search starts before
 * the scrape arguments finish streaming), that each tool ran once, and that
 * the structured output, the read-url evidence check and `usedFallbackValue`
 * come out as they did with the whole step awaited.
 *
 * Requires AIMock on `AIMOCK_URL` (`npm run test:ai` starts it).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import scrapeFixture from '../fixtures/firecrawl/scrape.json';
import searchFixture from '../fixtures/firecrawl/search.json';

const { searchMock, scrapeMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  scrapeMock: vi.fn(),
}));

vi.mock('firecrawl', () => ({
  Firecrawl: class {
    search = searchMock;
    scrape = scrapeMock;
    map = vi.fn();
    startAgent = vi.fn();
    getAgentStatus = vi.fn();
    cancelAgent = vi.fn().mockResolvedValue(true);
  },
}));

// Chat Completions (what `resolveModel` uses under AIMock) cannot show eager
// execution: `@ai-sdk/openai` emits a chat tool call only when the stream
// ends. The Responses API emits each call when its item is done, so this file
// routes research calls there.
vi.mock('@/lib/mastra/models', async (importOriginal) => {
  const { createOpenAI } = await import('@ai-sdk/openai');
  const original = await importOriginal<typeof import('@/lib/mastra/models')>();
  return {
    ...original,
    resolveModel: (...args: Parameters<typeof original.resolveModel>) =>
      args[0] === 'research'
        ? createOpenAI({ baseURL: `${process.env.AIMOCK_URL}/v1`, apiKey: 'mock' }).responses(
            process.env.AIMOCK_MODEL ?? 'gpt-4o-mini'
          )
        : original.resolveModel(...args),
  };
});

import { mastra } from '@/lib/mastra';
import { EnrichRowOutput, type EnrichRowInputType, type ResearchPlanType } from '@/lib/mastra/schemas';

import { AIMOCK_URL } from '../aimock';

const READS_SCRAPE_URL = 'https://www.firecrawl.dev/careers?check=eager-tool-execution-reads';
const FALLBACK_SCRAPE_URL = 'https://www.firecrawl.dev/careers?check=eager-tool-execution-fallback';

/**
 * The least time between the search and the scrape starting that shows the
 * search ran eagerly. The fixture streams the scrape arguments over about 20
 * chunks 25 ms apart after the search arguments are complete; awaiting the
 * whole step starts both tools within a few milliseconds of each other.
 */
const EAGER_GAP_MS = 150;

const field = (name: string, displayName: string) => ({
  name,
  displayName,
  description: `${displayName} of the company`,
  type: 'string' as const,
  examples: [],
  strategy: 'search' as const,
});

const group = (id: string, label: string, fieldNames: string[]) => ({
  id,
  label,
  fieldNames,
  strategy: 'search' as const,
  queries: ['{company} ' + label.toLowerCase()],
  preferredSources: ['the company website'],
  instructions: 'Use the company website.',
});

const PLAN: ResearchPlanType = {
  fields: [
    field('homepage_headline', 'Homepage Headline'),
    field('open_roles', 'Open Roles'),
    field('careers_summary', 'Careers Summary'),
  ],
  groups: [
    group('reads', 'Eager reads', ['homepage_headline', 'open_roles']),
    group('fallback', 'Eager fallback', ['careers_summary']),
  ],
  interpretation: 'Test plan for eager tool execution in the research step.',
};

const INPUT: EnrichRowInputType = {
  sessionId: 'session-eager-test',
  rowIndex: 0,
  email: 'eager@firecrawl.dev',
  plan: PLAN,
  fields: PLAN.fields.map(({ name, displayName, description, type }) => ({ name, displayName, description, type })),
};

type Chunk = { type: string; payload?: { output?: Record<string, unknown> } };

/** When each Firecrawl call started, keyed by its query or url. */
const startedAt = new Map<string, number[]>();

function record(key: unknown) {
  const times = startedAt.get(String(key)) ?? [];
  times.push(performance.now());
  startedAt.set(String(key), times);
}

let chunks: Chunk[];
let output: ReturnType<typeof EnrichRowOutput.parse>;

beforeAll(async () => {
  const health = await fetch(`${AIMOCK_URL}/health`).catch(() => undefined);
  if (!health?.ok) {
    throw new Error(
      `AIMock is not reachable at ${AIMOCK_URL}. Run \`npm run test:ai\`, or start \`npm run aimock\` in another terminal.`
    );
  }

  vi.spyOn(console, 'warn').mockImplementation(() => {});
  searchMock.mockImplementation(async (query: string) => {
    record(query);
    return searchFixture;
  });
  scrapeMock.mockImplementation(async (url: string) => {
    record(url);
    return scrapeFixture;
  });

  const run = await mastra.getWorkflow('enrichRow').createRun();
  const stream = run.stream({ inputData: INPUT });

  chunks = [];
  for await (const chunk of stream) chunks.push(chunk as Chunk);

  const result = await stream.result;
  if (result.status !== 'success') throw new Error(`workflow ${result.status}: ${JSON.stringify(result)}`);
  output = EnrichRowOutput.parse(result.result);
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
});

const groupResult = (groupId: string) => output.groups.find((candidate) => candidate.groupId === groupId);

/** The `group-complete` event the research step wrote for one group. */
const completeEvent = (groupId: string) =>
  chunks
    .filter((chunk) => chunk.type === 'workflow-step-output')
    .map((chunk) => chunk.payload?.output)
    .find((event) => event?.type === 'group-complete' && event.groupId === groupId);

/** The one start time of a call; fails when the call ran more or fewer times. */
function startedOnce(key: string): number {
  const times = startedAt.get(key) ?? [];
  expect(times, `${key} started ${times.length} times`).toHaveLength(1);
  return times[0];
}

describe('research step under eager tool execution', () => {
  it('starts each tool once, before the model finishes streaming the step', () => {
    for (const [query, url] of [
      ['eager reads', READS_SCRAPE_URL],
      ['eager fallback', FALLBACK_SCRAPE_URL],
    ]) {
      const search = startedOnce(query);
      const scrape = startedOnce(url);
      expect(scrape - search).toBeGreaterThanOrEqual(EAGER_GAP_MS);
    }
  });

  it('keeps a valid answer and the evidence read by both tools', () => {
    expect(groupResult('reads')).toMatchObject({ structuredOutputFailed: false, found: 2 });
    expect(completeEvent('reads')).toMatchObject({ structuredOutputFailed: false, found: 2 });
    expect(output.enrichments.homepage_headline?.value).toBe('Power AI agents with clean web data');
    expect(output.enrichments.open_roles?.value).toBe('Founding Engineer');
    expect(output.enrichments.open_roles?.sourceContext).toContainEqual(
      expect.objectContaining({ url: READS_SCRAPE_URL })
    );
  });

  it('still reports a structured-output fallback as a failure', () => {
    expect(groupResult('fallback')).toMatchObject({ structuredOutputFailed: true, found: 0 });
    expect(completeEvent('fallback')).toMatchObject({ structuredOutputFailed: true });
    expect(output.unknown).toContainEqual({
      field: 'careers_summary',
      reason: expect.stringMatching(/did not return a valid result/),
    });
  });
});
