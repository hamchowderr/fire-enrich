/**
 * `POST /api/enrich` and `DELETE /api/enrich` through the route handler.
 *
 * With `ENRICH_ENGINE=mastra` the route runs the enrichRow workflow: every
 * model call is answered by AIMock (`fixtures/identify-company.json`,
 * `fixtures/research-group.json`) and Firecrawl is mocked at the SDK boundary
 * on the recordings in `tests/fixtures/firecrawl/`. The plan is put in the plan
 * cache first, as field generation would, so the route finds it by field set.
 * With the flag unset the legacy strategy is used; it is mocked here, because
 * what is under test is the dispatch, not the legacy engine.
 *
 * Requires AIMock on `AIMOCK_URL` (`npm run test:ai` starts it).
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import agentFixture from '../fixtures/firecrawl/agent.json';
import mapFixture from '../fixtures/firecrawl/map.json';
import scrapeFixture from '../fixtures/firecrawl/scrape.json';
import searchFixture from '../fixtures/firecrawl/search.json';

const { searchMock, scrapeMock, mapMock, startAgentMock, getAgentStatusMock, legacyEnrichRow } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  scrapeMock: vi.fn(),
  mapMock: vi.fn(),
  startAgentMock: vi.fn(),
  getAgentStatusMock: vi.fn(),
  legacyEnrichRow: vi.fn(),
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

vi.mock('@/lib/strategies/agent-enrichment-strategy', () => ({
  AgentEnrichmentStrategy: class {
    enrichRow = legacyEnrichRow;
  },
}));

import { DELETE, POST } from '@/app/api/enrich/route';
import { putPlan } from '@/lib/mastra/plan-cache';
import type { ResearchPlanType } from '@/lib/mastra/schemas';

const AIMOCK_URL = process.env.AIMOCK_URL as string;

const plannedField = (name: string, displayName: string, strategy: 'search' | 'agent' | 'browser') => ({
  name,
  displayName,
  description: `${displayName} of the company`,
  type: 'string' as const,
  examples: [],
  strategy,
});

const group = (id: string, label: string, strategy: 'search' | 'agent' | 'browser', fieldNames: string[]) => ({
  id,
  label,
  fieldNames,
  strategy,
  queries: [`{company} ${label.toLowerCase()}`],
  preferredSources: ['the company website'],
  instructions: 'Use the company website.',
});

const PLAN: ResearchPlanType = {
  fields: [
    plannedField('product_summary', 'Product Summary', 'search'),
    plannedField('homepage_headline', 'Homepage Headline', 'browser'),
  ],
  groups: [
    group('product', 'Product and positioning', 'search', ['product_summary']),
    group('homepage', 'Homepage headline', 'browser', ['homepage_headline']),
  ],
  interpretation: 'Route test plan.',
};

/** The fields as the UI sends them (`EnrichmentField`). */
const FIELDS = PLAN.fields.map(({ name, displayName, description, type }) => ({
  name,
  displayName,
  description,
  type,
  required: false,
}));

type Event = { type: string; [key: string]: unknown };

function post(rows: Array<Record<string, string>>): Promise<Response> {
  return POST(
    new NextRequest('http://localhost/api/enrich', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows, fields: FIELDS, emailColumn: 'email' }),
    })
  );
}

/** Read an SSE response to the end, calling `onEvent` as each event arrives. */
async function readEvents(response: Response, onEvent?: (event: Event) => void): Promise<Event[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Event[] = [];
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (!frame.startsWith('data: ')) continue;
      const event = JSON.parse(frame.slice(6)) as Event;
      events.push(event);
      onEvent?.(event);
    }
  }

  return events;
}

const toolCalls = () =>
  searchMock.mock.calls.length +
  scrapeMock.mock.calls.length +
  mapMock.mock.calls.length +
  startAgentMock.mock.calls.length;

beforeAll(async () => {
  const health = await fetch(`${AIMOCK_URL}/health`).catch(() => undefined);
  if (!health?.ok) throw new Error(`AIMock is not reachable at ${AIMOCK_URL}.`);
});

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  searchMock.mockResolvedValue(searchFixture);
  scrapeMock.mockResolvedValue(scrapeFixture);
  mapMock.mockResolvedValue(mapFixture);
  startAgentMock.mockResolvedValue({ success: true, id: 'agent_fixture_job' });
  getAgentStatusMock.mockResolvedValue(agentFixture);
  putPlan(PLAN);
});

afterEach(() => {
  delete process.env.ENRICH_ENGINE;
  vi.restoreAllMocks();
  for (const mock of [searchMock, scrapeMock, mapMock, startAgentMock, getAgentStatusMock, legacyEnrichRow]) {
    mock.mockReset();
  }
});

describe('POST /api/enrich with ENRICH_ENGINE=mastra', () => {
  it('streams one row from session to complete', { timeout: 120_000 }, async () => {
    process.env.ENRICH_ENGINE = 'mastra';

    const events = await readEvents(await post([{ email: 'hello@firecrawl.dev' }]));
    const types = events.map((event) => event.type);

    // Framing, in order.
    expect(types[0]).toBe('session');
    expect(types[1]).toBe('pending');
    expect(types.indexOf('processing')).toBeGreaterThan(1);
    expect(types.indexOf('agent_progress')).toBeGreaterThan(types.indexOf('processing'));
    expect(types.indexOf('result')).toBeGreaterThan(types.lastIndexOf('agent_progress'));
    expect(types.at(-1)).toBe('complete');
    expect(types).not.toContain('error');

    const progress = events.filter((event) => event.type === 'agent_progress');
    const messages = progress.map((event) => event.message);

    expect(messages).toContain('Identifying company from firecrawl.dev');
    expect(messages).toContain('Identified Firecrawl (https://www.firecrawl.dev/)');
    expect(messages).toContain('Product and positioning: searching (product_summary)');
    expect(messages).toContain('Product and positioning complete: 1 field');
    expect(messages).toContain('Homepage headline complete: 1 field');
    expect(progress.every((event) => event.rowIndex === 0)).toBe(true);
    expect(progress.some((event) => event.sourceUrl === 'https://www.firecrawl.dev/')).toBe(true);
    expect(progress.find((event) => event.message === 'product_summary: evidence from firecrawl.dev')).toMatchObject({
      messageType: 'success',
      sourceUrl: 'https://www.firecrawl.dev/',
    });

    const { result } = events.find((event) => event.type === 'result') as unknown as {
      result: { rowIndex: number; status: string; enrichments: Record<string, { value: unknown; source?: string; sourceContext?: Array<{ url: string }> }> };
    };

    expect(result.rowIndex).toBe(0);
    expect(result.status).toBe('completed');
    expect(Object.keys(result.enrichments).sort()).toEqual(['homepage_headline', 'product_summary']);
    expect(result.enrichments.homepage_headline).toMatchObject({
      value: 'Power AI agents with clean web data',
      source: 'https://www.firecrawl.dev/',
    });
    // The fixture's quote from a page no tool read never reaches the UI.
    expect(result.enrichments.product_summary.sourceContext?.map((context) => context.url)).toEqual([
      'https://www.firecrawl.dev/',
    ]);
  });

  it('skips a personal email without running it', { timeout: 30_000 }, async () => {
    process.env.ENRICH_ENGINE = 'mastra';

    const events = await readEvents(await post([{ email: 'someone@gmail.com' }]));

    expect(events.map((event) => event.type)).toEqual(['session', 'pending', 'result', 'complete']);
    expect(events[2]).toMatchObject({
      result: { rowIndex: 0, status: 'skipped', error: 'Common email provider', enrichments: {} },
    });
    expect(toolCalls()).toBe(0);
  });

  it('cancels mid-run: `cancelled`, no more tool calls, no result', { timeout: 60_000 }, async () => {
    process.env.ENRICH_ENGINE = 'mastra';

    // The first search holds for ten seconds, so the DELETE lands mid-call.
    searchMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(searchFixture), 10_000))
    );

    let cancelledAt = 0;
    let callsAtCancel = 0;
    let sessionId = '';

    const response = await post([{ email: 'hello@firecrawl.dev' }]);
    const started = Date.now();

    const events = await readEvents(response, (event) => {
      if (event.type === 'session') sessionId = event.sessionId as string;
      // The identify step's first search is held, so this lands mid-call.
      if (event.type === 'agent_progress' && String(event.message).startsWith('Searching the web') && !cancelledAt) {
        cancelledAt = Date.now();
        callsAtCancel = toolCalls();
        void DELETE(new NextRequest(`http://localhost/api/enrich?sessionId=${sessionId}`, { method: 'DELETE' }));
      }
    });

    const types = events.map((event) => event.type);

    expect(cancelledAt).toBeGreaterThan(0);
    expect(types).toContain('cancelled');
    expect(types).not.toContain('result');
    expect(types).not.toContain('complete');
    // The stream ended within seconds of the cancel, well before the held
    // search would have returned.
    expect(Date.now() - cancelledAt).toBeLessThan(3_000);
    expect(Date.now() - started).toBeLessThan(10_000);

    // Nothing new is called after the cancel, even once the held call settles.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(toolCalls()).toBe(callsAtCancel);
  });

  it('answers 404 to a DELETE for an unknown session', async () => {
    const response = await DELETE(new NextRequest('http://localhost/api/enrich?sessionId=missing', { method: 'DELETE' }));

    expect(response.status).toBe(404);
  });
});

describe('POST /api/enrich without ENRICH_ENGINE', () => {
  it('dispatches to the legacy strategy exactly as before', { timeout: 30_000 }, async () => {
    legacyEnrichRow.mockImplementation(async (row, _fields, _emailColumn, _onProgress, onAgentProgress) => {
      onAgentProgress('Legacy agent working', 'info', 'https://legacy.example/');
      return {
        rowIndex: 0,
        originalData: row,
        enrichments: { product_summary: { field: 'product_summary', value: 'legacy value', confidence: 0.5 } },
        status: 'completed',
      };
    });

    const events = await readEvents(await post([{ email: 'hello@firecrawl.dev' }]));

    expect(events.map((event) => event.type)).toEqual([
      'session',
      'pending',
      'processing',
      'agent_progress',
      'result',
      'complete',
    ]);
    expect(events[3]).toMatchObject({ message: 'Legacy agent working', messageType: 'info', sourceUrl: 'https://legacy.example/' });
    expect(events[4]).toMatchObject({ result: { status: 'completed', enrichments: { product_summary: { value: 'legacy value' } } } });
    expect(legacyEnrichRow).toHaveBeenCalledOnce();
    expect(toolCalls()).toBe(0);
  });
});
