/**
 * The `enrichRow` workflow end to end for one row, with every model call
 * answered by AIMock (`fixtures/identify-company.json`,
 * `fixtures/research-group.json`) and Firecrawl mocked at the SDK boundary on
 * the recordings in `tests/fixtures/firecrawl/`.
 *
 * The plan below is hand-written with one group per strategy plus a fourth
 * group whose model answer is not JSON, so one run covers: identification, a
 * search group, a hosted-agent group, a browser group running in its own pass,
 * the evidence check dropping a url no tool read, and a structured-output miss
 * that leaves its field unknown while the row still completes, and a scrape
 * that fails with a 404 whose invented quote is dropped.
 *
 * Requires AIMock on `AIMOCK_URL` (`npm run test:ai` starts it).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import agentFixture from '../fixtures/firecrawl/agent.json';
import mapFixture from '../fixtures/firecrawl/map.json';
import scrapeFixture from '../fixtures/firecrawl/scrape.json';
import searchFixture from '../fixtures/firecrawl/search.json';

const { searchMock, scrapeMock, mapMock, startAgentMock, getAgentStatusMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  scrapeMock: vi.fn(),
  mapMock: vi.fn(),
  startAgentMock: vi.fn(),
  getAgentStatusMock: vi.fn(),
}));

vi.mock('firecrawl', () => ({
  Firecrawl: class {
    search = searchMock;
    scrape = scrapeMock;
    map = mapMock;
    startAgent = startAgentMock;
    getAgentStatus = getAgentStatusMock;
    cancelAgent = vi.fn().mockResolvedValue(true);
  },
}));

import { mastra } from '@/lib/mastra';
import { EnrichRowOutput, type EnrichRowInputType, type ResearchPlanType } from '@/lib/mastra/schemas';

const AIMOCK_URL = process.env.AIMOCK_URL as string;

const field = (name: string, displayName: string, strategy: 'search' | 'agent' | 'browser', type = 'string') => ({
  name,
  displayName,
  description: `${displayName} of the company`,
  type: type as 'string' | 'number',
  examples: [],
  strategy,
});

const group = (
  id: string,
  label: string,
  strategy: 'search' | 'agent' | 'browser',
  fieldNames: string[]
) => ({
  id,
  label,
  fieldNames,
  strategy,
  queries: ['{company} ' + label.toLowerCase(), 'site:{domain} ' + id],
  preferredSources: ['the company website'],
  instructions: 'Use the company website.',
});

const PLAN: ResearchPlanType = {
  fields: [
    field('product_summary', 'Product Summary', 'search'),
    field('open_source_repo', 'Open Source Repo', 'agent'),
    field('homepage_headline', 'Homepage Headline', 'browser'),
    field('employee_count', 'Employee Count', 'search', 'number'),
    field('open_roles', 'Open Roles', 'search'),
  ],
  groups: [
    group('product', 'Product and positioning', 'search', ['product_summary']),
    group('open-source', 'Open source footprint', 'agent', ['open_source_repo']),
    group('homepage', 'Homepage headline', 'browser', ['homepage_headline']),
    group('team', 'Team size', 'search', ['employee_count']),
    group('careers', 'Careers page', 'search', ['open_roles']),
  ],
  interpretation: 'Test plan with one group per strategy.',
};

const INPUT: EnrichRowInputType = {
  sessionId: 'session-test',
  rowIndex: 3,
  email: 'hello@firecrawl.dev',
  plan: PLAN,
  fields: PLAN.fields.map(({ name, displayName, description, type }) => ({ name, displayName, description, type })),
};

type Chunk = { type: string; payload?: { output?: Record<string, unknown>; stepName?: string } };

let chunks: Chunk[];
let output: ReturnType<typeof EnrichRowOutput.parse>;
let status: string;
const scrapedUrls: string[] = [];

/** The chat requests AIMock received. */
async function journal(): Promise<Array<{ body?: { messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ function?: { name?: string } }> } }>> {
  const response = await fetch(`${AIMOCK_URL}/__aimock/journal?path=/v1/chat/completions`);
  const entries = (await response.json()) as unknown;
  return Array.isArray(entries) ? entries : [];
}

beforeAll(async () => {
  const health = await fetch(`${AIMOCK_URL}/health`).catch(() => undefined);
  if (!health?.ok) {
    throw new Error(
      `AIMock is not reachable at ${AIMOCK_URL}. Run \`npm run test:ai\`, or start \`npm run aimock\` in another terminal.`
    );
  }

  vi.spyOn(console, 'warn').mockImplementation(() => {});
  searchMock.mockResolvedValue(searchFixture);
  // The careers page does not exist: the scrape fails, so it was never read.
  scrapeMock.mockImplementation(async (url: string) => {
    scrapedUrls.push(url);
    if (url.includes('/careers')) throw Object.assign(new Error('Request failed with status code 404'), { status: 404 });
    return scrapeFixture;
  });
  mapMock.mockResolvedValue(mapFixture);
  startAgentMock.mockResolvedValue({ success: true, id: 'agent_fixture_job' });
  getAgentStatusMock.mockResolvedValue(agentFixture);

  const run = await mastra.getWorkflow('enrichRow').createRun();
  const stream = run.stream({ inputData: INPUT });

  chunks = [];
  for await (const chunk of stream) chunks.push(chunk as Chunk);

  const result = await stream.result;
  status = result.status;
  if (result.status !== 'success') throw new Error(`workflow ${result.status}: ${JSON.stringify(result)}`);
  output = EnrichRowOutput.parse(result.result);
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
});

/** Events the research steps wrote to their stream. */
function stepEvents(type: string) {
  return chunks
    .filter((chunk) => chunk.type === 'workflow-step-output')
    .map((chunk) => chunk.payload?.output)
    .filter((event): event is Record<string, unknown> => event?.type === type);
}

describe('enrichRow workflow', () => {
  it('completes the row', () => {
    expect(status).toBe('success');
    expect(output.rowIndex).toBe(3);
    expect(output.email).toBe('hello@firecrawl.dev');
    expect(output.planSource).toBe('input');
  });

  it('identifies the company from the email', () => {
    expect(output.company).toEqual({
      companyName: 'Firecrawl',
      domain: 'firecrawl.dev',
      website: 'https://www.firecrawl.dev/',
      description: 'The web data API to search, scrape, and interact at scale.',
      confidence: 0.95,
    });
  });

  it('fills the plan queries from the identified company', async () => {
    const research = (await journal()).find((entry) =>
      JSON.stringify(entry.body?.messages).includes('Research group: Product and positioning')
    );
    const prompt = JSON.stringify(research?.body?.messages);

    expect(prompt).toContain('Firecrawl product and positioning');
    expect(prompt).toContain('site:firecrawl.dev product');
    expect(prompt).not.toContain('{company}');
  });

  it('returns one evidence-backed finding per group, citing urls Firecrawl returned', () => {
    const returned = new Set([
      ...searchFixture.web.map((item) => item.url),
      scrapeFixture.metadata.url,
      'https://github.com/firecrawl/firecrawl',
    ]);

    expect(Object.keys(output.enrichments).sort()).toEqual(
      ['homepage_headline', 'open_source_repo', 'product_summary'].sort()
    );

    for (const enrichment of Object.values(output.enrichments)) {
      expect(enrichment.sourceContext?.length).toBeGreaterThan(0);
      for (const context of enrichment.sourceContext ?? []) expect(returned).toContain(context.url);
    }

    expect(output.enrichments.open_source_repo.value).toBe('https://github.com/firecrawl/firecrawl');
    expect(output.enrichments.homepage_headline.source).toBe('https://www.firecrawl.dev/');
  });

  it('drops a quote whose url no tool read', () => {
    const product = output.enrichments.product_summary;

    expect(product.sourceContext?.map((context) => context.url)).toEqual(['https://www.firecrawl.dev/']);
    expect(output.groups.find((group) => group.groupId === 'product')?.notes).toMatch(/no tool read/);
  });

  it('leaves the fields of a group whose structured output failed unknown', () => {
    expect(output.enrichments.employee_count).toBeUndefined();
    expect(output.unknown).toContainEqual({
      field: 'employee_count',
      reason: expect.stringMatching(/did not return a valid result/),
    });
    expect(output.groups.find((group) => group.groupId === 'team')).toMatchObject({
      structuredOutputFailed: true,
      found: 0,
    });
  });

  it('drops a quote citing a page whose scrape failed', () => {
    expect(scrapedUrls).toContain('https://www.firecrawl.dev/careers');
    expect(output.enrichments.open_roles).toBeUndefined();
    expect(output.unknown).toContainEqual({ field: 'open_roles', reason: expect.stringMatching(/no tool read/) });
    expect(output.unknown.map((item) => item.field).sort()).toEqual(['employee_count', 'open_roles']);
  });

  it('runs the browser group in its own pass, after the others', () => {
    const order = output.groups.map((group) => group.groupId);

    expect(order).toEqual(['product', 'open-source', 'team', 'careers', 'homepage']);
    expect(output.groups.find((group) => group.groupId === 'homepage')?.strategy).toBe('browser');
  });

  it('gives each strategy its own tools', async () => {
    const entries = await journal();
    const toolsFor = (label: string) =>
      entries
        .find((entry) => JSON.stringify(entry.body?.messages).includes(`Research group: ${label}`))
        ?.body?.tools?.map((tool) => tool.function?.name)
        .sort();

    expect(toolsFor('Product and positioning')).toEqual(['map', 'scrape', 'search']);
    expect(toolsFor('Open source footprint')).toEqual(['firecrawlAgent', 'map', 'scrape', 'search']);
    expect(toolsFor('Homepage headline')).toEqual(['agent-browser', 'map', 'scrape', 'search']);
  });

  it('maps findings to the EnrichmentResult shape', () => {
    expect(output.enrichments.homepage_headline).toEqual({
      field: 'homepage_headline',
      value: 'Power AI agents with clean web data',
      confidence: 0.9,
      source: 'https://www.firecrawl.dev/',
      sourceContext: [{ url: 'https://www.firecrawl.dev/', snippet: '# Power AI agents with   clean web data' }],
      sourceCount: 1,
      corroboration: {
        evidence: [
          {
            value: 'Power AI agents with clean web data',
            source_url: 'https://www.firecrawl.dev/',
            exact_text: '# Power AI agents with   clean web data',
            confidence: 0.9,
          },
        ],
        sources_agree: true,
      },
    });
  });

  it('streams Firecrawl progress and evidence events tagged with their group', () => {
    const progress = stepEvents('firecrawl-progress');
    const evidence = stepEvents('evidence');

    expect(progress.some((event) => event.groupId === 'product' && event.sourceUrl === 'https://www.firecrawl.dev/')).toBe(
      true
    );
    expect(progress.some((event) => event.groupId === 'open-source')).toBe(true);
    expect(evidence).toEqual(
      expect.arrayContaining([
        {
          type: 'evidence',
          groupId: 'homepage',
          field: 'homepage_headline',
          url: 'https://www.firecrawl.dev/',
          quote: '# Power AI agents with   clean web data',
        },
      ])
    );
    expect(evidence.some((event) => event.url === 'https://unread.example/about')).toBe(false);
  });
});
