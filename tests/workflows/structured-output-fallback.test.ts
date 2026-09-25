/**
 * How the research step tells a structured-output fallback apart from a real
 * answer. With `errorStrategy: 'fallback'` Mastra substitutes the configured
 * `NO_FINDINGS` value and sets `usedFallbackValue`; the step must read that
 * flag, not the note the fallback value carries.
 *
 * One `enrichRow` run with three groups, every model call answered by AIMock
 * (`fixtures/research-group.json`):
 * - "Product and positioning" returns a valid answer with a finding.
 * - "Team size" returns text that is not JSON, so Mastra falls back.
 * - "Funding stage" returns a valid answer whose notes are, word for word, the
 *   note the fallback value carries.
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

import { mastra } from '@/lib/mastra';
import { EnrichRowOutput, type EnrichRowInputType, type ResearchPlanType } from '@/lib/mastra/schemas';

const AIMOCK_URL = process.env.AIMOCK_URL as string;

/** The note on the fallback value, which a model can also write on its own. */
const FALLBACK_NOTE = 'The research result did not match the expected format, so no findings were kept.';

const field = (name: string, displayName: string, type: 'string' | 'number' = 'string') => ({
  name,
  displayName,
  description: `${displayName} of the company`,
  type,
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
    field('product_summary', 'Product Summary'),
    field('employee_count', 'Employee Count', 'number'),
    field('funding_stage', 'Funding Stage'),
  ],
  groups: [
    group('product', 'Product and positioning', ['product_summary']),
    group('team', 'Team size', ['employee_count']),
    group('funding', 'Funding stage', ['funding_stage']),
  ],
  interpretation: 'Test plan for structured-output fallback detection.',
};

const INPUT: EnrichRowInputType = {
  sessionId: 'session-fallback-test',
  rowIndex: 0,
  email: 'hello@firecrawl.dev',
  plan: PLAN,
  fields: PLAN.fields.map(({ name, displayName, description, type }) => ({ name, displayName, description, type })),
};

type Chunk = { type: string; payload?: { output?: Record<string, unknown> } };

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
  searchMock.mockResolvedValue(searchFixture);
  scrapeMock.mockResolvedValue(scrapeFixture);

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

describe('structured-output fallback detection', () => {
  it('does not report a valid answer as a failure', () => {
    expect(groupResult('product')).toMatchObject({ structuredOutputFailed: false });
    expect(completeEvent('product')).toMatchObject({ structuredOutputFailed: false });
    expect(output.enrichments.product_summary?.value).toBe('The web data API to search, scrape, and interact at scale.');
  });

  it('reports the fallback as a failure and keeps its note for the user', () => {
    expect(groupResult('team')).toMatchObject({ structuredOutputFailed: true, found: 0 });
    expect(groupResult('team')?.notes).toContain(FALLBACK_NOTE);
    expect(completeEvent('team')).toMatchObject({ structuredOutputFailed: true });
    expect(output.unknown).toContainEqual({
      field: 'employee_count',
      reason: expect.stringMatching(/did not return a valid result/),
    });
  });

  it('does not report a valid answer whose notes match the fallback note as a failure', () => {
    expect(groupResult('funding')).toMatchObject({ structuredOutputFailed: false, found: 0 });
    expect(groupResult('funding')?.notes).toBe(FALLBACK_NOTE);
    expect(completeEvent('funding')).toMatchObject({ structuredOutputFailed: false });
    expect(output.unknown).toContainEqual({
      field: 'funding_stage',
      reason: expect.stringMatching(/returned no finding for this field/),
    });
  });
});
