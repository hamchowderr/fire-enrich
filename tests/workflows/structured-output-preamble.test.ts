/**
 * Research calls whose tool-calling steps carry text, and one that runs out
 * of steps.
 *
 * Claude usually opens a tool-calling turn with text such as "I'll search
 * for ...". With structured output in direct mode (no structuring `model`),
 * `@mastra/core` 1.71 validates the text of every model step against the
 * schema, not only the last one, and the first result it gets, valid or not,
 * becomes `stream.object`. A step that is only a sentence plus a tool call
 * then ends the group with no findings, even when the model's last step is a
 * valid answer. The loss is silent: on that path `usedFallbackValue` is false,
 * so the group reported `structuredOutputFailed: false, found: 0`. The
 * research step now asks for a structuring `model` (processor mode), which
 * structures the transcript once the loop ends, with instructions that name
 * the group's fields.
 *
 * One `enrichRow` run with three groups, every model call answered by AIMock
 * (`fixtures/research-preamble.json`):
 * - "Preamble once": a sentence and a search, then a valid answer.
 * - "Preamble every step": a sentence and a search, a sentence and a scrape,
 *   then a valid answer.
 * - "Out of steps": a sentence and a search on every step, so the loop stops
 *   at its step limit on a tool call and the model never answers.
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

import { AIMOCK_URL } from '../aimock';

const TAGLINE = 'The web data API to search, scrape, and interact at scale.';

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
    field('product_summary', 'Product Summary'),
    field('tagline', 'Tagline'),
    field('homepage_headline', 'Homepage Headline'),
  ],
  groups: [
    group('once', 'Preamble once', ['product_summary']),
    group('every', 'Preamble every step', ['tagline']),
    group('out', 'Out of steps', ['homepage_headline']),
  ],
  interpretation: 'Test plan for text written before tool calls.',
};

const INPUT: EnrichRowInputType = {
  sessionId: 'session-preamble-test',
  rowIndex: 0,
  email: 'hello@firecrawl.dev',
  plan: PLAN,
  fields: PLAN.fields.map(({ name, displayName, description, type }) => ({ name, displayName, description, type })),
};

type Chunk = { type: string; payload?: { output?: Record<string, unknown> } };

let chunks: Chunk[];
let output: ReturnType<typeof EnrichRowOutput.parse>;
let searchQueries: string[];

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
  searchQueries = searchMock.mock.calls.map(([query]) => query as string);
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
});

const groupResult = (groupId: string) => output.groups.find((candidate) => candidate.groupId === groupId);

const completeEvent = (groupId: string) =>
  chunks
    .filter((chunk) => chunk.type === 'workflow-step-output')
    .map((chunk) => chunk.payload?.output)
    .find((event) => event?.type === 'group-complete' && event.groupId === groupId);

describe('text before tool calls', () => {
  it('keeps the final answer when the model writes a sentence before its one tool call', () => {
    expect(groupResult('once')).toMatchObject({ structuredOutputFailed: false, found: 1 });
    expect(completeEvent('once')).toMatchObject({ structuredOutputFailed: false, found: 1 });
    expect(output.enrichments.product_summary?.value).toBe(TAGLINE);
  });

  it('keeps the final answer when every tool-calling step starts with a sentence', () => {
    expect(groupResult('every')).toMatchObject({ structuredOutputFailed: false, found: 1 });
    expect(completeEvent('every')).toMatchObject({ structuredOutputFailed: false, found: 1 });
    expect(output.enrichments.tagline?.value).toBe(TAGLINE);
  });

  it('ends a loop that would run out of steps with an answer, on a step with no tools', async () => {
    // A search group may take 10 steps: 9 search, the 10th must answer.
    expect(searchQueries.filter((query) => query === 'Firecrawl headline out of steps')).toHaveLength(9);

    // The research calls of this group, as AIMock received them. The journal
    // keeps every request since the server started, so take this run's 10.
    const journal = (await (await fetch(`${AIMOCK_URL}/__aimock/journal`)).json()) as Array<{
      body: { tools?: unknown[]; messages: Array<{ role: string; content: unknown }> };
    }>;
    const calls = journal
      .map((entry) => entry.body)
      .filter((body) =>
        body.messages.some(
          (message) => message.role === 'user' && JSON.stringify(message.content).includes('Research group: Out of steps')
        )
      )
      .slice(-10);
    expect(calls.map((body) => (body.tools?.length ?? 0) > 0)).toEqual([...Array(9).fill(true), false]);
    const lastSystem = JSON.stringify(calls[9]?.messages.filter((message) => message.role === 'system'));
    expect(lastSystem).toContain('You have no tool calls left.');

    expect(groupResult('out')).toMatchObject({ structuredOutputFailed: false, found: 1 });
    expect(output.enrichments.homepage_headline?.value).toBe('Power AI agents with clean web data');
  });

  it('gives each structuring call the group’s field names and evidence rules, with the schema as its response format', async () => {
    const journal = (await (await fetch(`${AIMOCK_URL}/__aimock/journal`)).json()) as Array<{
      body: {
        response_format?: { type?: string };
        tools?: unknown[];
        messages: Array<{ role: string; content: unknown }>;
      };
    }>;
    const system = (body: (typeof journal)[number]['body']) =>
      JSON.stringify(body.messages.filter((message) => message.role === 'system'));
    const transcript = (body: (typeof journal)[number]['body']) =>
      JSON.stringify(body.messages.filter((message) => message.role === 'user'));

    // The last structuring call whose transcript holds the group's own search.
    const structuringCall = (query: string) =>
      journal
        .map((entry) => entry.body)
        .filter((body) => system(body).includes('You turn a research transcript') && transcript(body).includes(query))
        .at(-1);

    for (const [query, fieldName] of [
      ['Firecrawl product', 'product_summary'],
      ['Firecrawl funding', 'tagline'],
      ['Firecrawl headline out of steps', 'homepage_headline'],
    ]) {
      const call = structuringCall(query);
      expect(call, `structuring call for ${fieldName}`).toBeDefined();
      expect(system(call!)).toContain(`Fields: ${fieldName}.`);
      expect(system(call!)).toContain('word for word');
      expect(system(call!)).toContain('report the field with value null, confidence 0 and empty evidence rather than guess');
      expect(call!.response_format?.type).toBe('json_schema');
      expect(call!.tools ?? []).toHaveLength(0);
    }
  });
});
