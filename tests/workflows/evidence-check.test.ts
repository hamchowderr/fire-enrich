/**
 * The evidence-support check inside `enrichRow`: the research step asks the
 * registered `evidenceSupport` classifier about each finding only when
 * `EVIDENCE_CHECK` is on, and a finding it rejects ends up unknown exactly
 * like one `checkFindings` rejected.
 *
 * The classifier's evaluation model is replaced by a spy, so no call reaches
 * the gateway. Model calls for the research agent are answered by AIMock
 * (`fixtures/research-group.json`), Firecrawl by the recordings.
 *
 * Requires AIMock on `AIMOCK_URL` (`npm run test:ai` starts it).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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

const PLAN: ResearchPlanType = {
  fields: [
    {
      name: 'product_summary',
      displayName: 'Product Summary',
      description: 'Product Summary of the company',
      type: 'string',
      examples: [],
      strategy: 'search',
    },
  ],
  groups: [
    {
      id: 'product',
      label: 'Product and positioning',
      fieldNames: ['product_summary'],
      strategy: 'search',
      queries: ['{company} product and positioning'],
      preferredSources: ['the company website'],
      instructions: 'Use the company website.',
    },
  ],
  interpretation: 'Test plan for the evidence-support check.',
};

const INPUT: EnrichRowInputType = {
  sessionId: 'session-evidence-check-test',
  rowIndex: 0,
  email: 'hello@firecrawl.dev',
  plan: PLAN,
  fields: PLAN.fields.map(({ name, displayName, description, type }) => ({ name, displayName, description, type })),
};

type Chunk = { type: string; payload?: { output?: Record<string, unknown> } };

async function runRow() {
  const run = await mastra.getWorkflow('enrichRow').createRun();
  const stream = run.stream({ inputData: INPUT });
  const chunks: Chunk[] = [];
  for await (const chunk of stream) chunks.push(chunk as Chunk);

  const result = await stream.result;
  if (result.status !== 'success') throw new Error(`workflow ${result.status}: ${JSON.stringify(result)}`);
  const evidenceEvents = chunks
    .filter((chunk) => chunk.type === 'workflow-step-output')
    .map((chunk) => chunk.payload?.output)
    .filter((event) => event?.type === 'evidence');
  return { output: EnrichRowOutput.parse(result.result), evidenceEvents };
}

/** Replace the registered classifier's model with a spy answering `probability`. */
function stubClassifier(probability: number) {
  const classifier = mastra.getClassifier('evidenceSupport');
  return vi.spyOn(classifier.model, 'doEvaluate').mockResolvedValue({
    answers: { supported: { type: 'boolean', probability } },
    warnings: [],
  });
}

beforeAll(async () => {
  const health = await fetch(`${AIMOCK_URL}/health`).catch(() => undefined);
  if (!health?.ok) {
    throw new Error(
      `AIMock is not reachable at ${AIMOCK_URL}. Run \`npm run test:ai\`, or start \`npm run aimock\` in another terminal.`
    );
  }
  searchMock.mockResolvedValue(searchFixture);
  scrapeMock.mockResolvedValue(scrapeFixture);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('evidence-support check in enrichRow', () => {
  it('makes no classifier call when EVIDENCE_CHECK is off', async () => {
    vi.stubEnv('EVIDENCE_CHECK', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doEvaluate = stubClassifier(0.01);

    const { output } = await runRow();

    expect(doEvaluate).not.toHaveBeenCalled();
    expect(output.enrichments.product_summary?.value).toBe('The web data API to search, scrape, and interact at scale.');
  }, 120_000);

  it('keeps a supported finding when the check is on', async () => {
    vi.stubEnv('EVIDENCE_CHECK', '1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doEvaluate = stubClassifier(0.93);

    const { output, evidenceEvents } = await runRow();

    expect(doEvaluate).toHaveBeenCalledTimes(1);
    expect(doEvaluate.mock.calls[0][0].state).toMatchObject({
      field: 'product_summary',
      fieldDescription: 'Product Summary of the company',
      value: 'The web data API to search, scrape, and interact at scale.',
    });
    expect(output.enrichments.product_summary?.value).toBe('The web data API to search, scrape, and interact at scale.');
    expect(evidenceEvents.length).toBeGreaterThan(0);
  }, 120_000);

  it('leaves an unsupported finding unknown, as a failed evidence check does', async () => {
    vi.stubEnv('EVIDENCE_CHECK', '1');
    vi.stubEnv('EVIDENCE_CHECK_THRESHOLD', '0.5');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubClassifier(0.12);

    const { output, evidenceEvents } = await runRow();

    expect(output.enrichments.product_summary).toBeUndefined();
    expect(output.unknown).toContainEqual({
      field: 'product_summary',
      reason: expect.stringMatching(/No evidence found by research group "product"\..*did not support the value/),
    });
    expect(output.groups[0]).toMatchObject({ groupId: 'product', found: 0, structuredOutputFailed: false });
    expect(evidenceEvents).toEqual([]);
  }, 120_000);
});
