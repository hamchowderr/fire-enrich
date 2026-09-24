/**
 * `POST /api/enrich` and `DELETE /api/enrich` through the route handler,
 * including a client that disconnects without a DELETE.
 *
 * The route runs the enrichRow workflow for every row: every model call is answered by AIMock (`fixtures/identify-company.json`,
 * `fixtures/research-group.json`) and Firecrawl is mocked at the SDK boundary
 * on the recordings in `tests/fixtures/firecrawl/`. The plan is put in the plan
 * cache first, as field generation would, so the route finds it by field set.
 *
 * The Dolt run store (`lib/runs.ts`) is mocked too: its SQL is covered by
 * `tests/runs/`, and what is under test here is when the route calls it.
 * Recording is off (`doltConfigured()` false) unless a test turns it on.
 *
 * Requires AIMock on `AIMOCK_URL` (`npm run test:ai` starts it).
 */
import { NextRequest, after } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const runs = vi.hoisted(() => ({
  doltConfigured: vi.fn(),
  startRun: vi.fn(),
  recordRow: vi.fn(),
  finishRun: vi.fn(),
  abandonRun: vi.fn(),
}));

vi.mock('@/lib/dolt', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dolt')>()),
  doltConfigured: runs.doltConfigured,
}));

vi.mock('@/lib/runs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/runs')>()),
  startRun: runs.startRun,
  recordRow: runs.recordRow,
  finishRun: runs.finishRun,
  abandonRun: runs.abandonRun,
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

import { DELETE, POST } from '@/app/api/enrich/route';
import { ENRICHMENT_CONFIG } from '@/lib/config/enrichment';
import { mastra } from '@/lib/mastra';
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

function post(rows: Array<Record<string, string>>, signal?: AbortSignal): Promise<Response> {
  return POST(
    new NextRequest('http://localhost/api/enrich', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rows, fields: FIELDS, emailColumn: 'email' }),
      signal,
    })
  );
}

/**
 * Read an SSE response to the end, calling `onEvent` as each event arrives.
 * `onEvent` gets the reader too, so a test can cancel it as a closed tab would.
 */
async function readEvents(
  response: Response,
  onEvent?: (event: Event, reader: ReadableStreamDefaultReader<Uint8Array>) => void
): Promise<Event[]> {
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
      onEvent?.(event, reader);
    }
  }

  return events;
}

const toolCalls = () =>
  searchMock.mock.calls.length +
  scrapeMock.mock.calls.length +
  mapMock.mock.calls.length +
  startAgentMock.mock.calls.length;

/** Watch the model calls, which go to AIMock through the global fetch. */
function watchModelCalls() {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  return () => fetchSpy.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).startsWith(AIMOCK_URL)).length;
}

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
  runs.doltConfigured.mockReturnValue(false);
  runs.startRun.mockResolvedValue('run_1');
  runs.recordRow.mockResolvedValue(1);
  runs.finishRun.mockResolvedValue('hash_1');
  runs.abandonRun.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [searchMock, scrapeMock, mapMock, startAgentMock, getAgentStatusMock, ...Object.values(runs)]) {
    mock.mockReset();
  }
});

describe('POST /api/enrich', () => {
  it('streams one row from session to complete', { timeout: 120_000 }, async () => {
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
    // Dolt is off here, so no run was recorded.
    expect(events.at(-1)).toEqual({ type: 'complete', runId: null });

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
    const events = await readEvents(await post([{ email: 'someone@gmail.com' }]));

    expect(events.map((event) => event.type)).toEqual(['session', 'pending', 'result', 'complete']);
    expect(events[2]).toMatchObject({
      result: { rowIndex: 0, status: 'skipped', error: 'Common email provider', enrichments: {} },
    });
    expect(toolCalls()).toBe(0);
  });

  it('cancels mid-run: `cancelled`, no more tool calls, no result', { timeout: 60_000 }, async () => {
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

  it('cancels during plan resolution: `cancelled`, not `error`', { timeout: 30_000 }, async () => {
    // A cold cache for these fields, and a planner call that only ends when
    // it is aborted, as a real one would on the route's signal.
    const planner = mastra.getAgent('planner');
    const heldUntilAborted = (_message: unknown, options?: { abortSignal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        const signal = options?.abortSignal;
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      });
    const generate = vi
      .spyOn(planner, 'generate')
      .mockImplementation(heldUntilAborted as unknown as typeof planner.generate);

    const uncached = [{ name: 'uncached_field', displayName: 'Uncached Field', description: 'x', type: 'string', required: false }];
    const response = await POST(
      new NextRequest('http://localhost/api/enrich', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rows: [{ email: 'hello@firecrawl.dev' }], fields: uncached, emailColumn: 'email' }),
      })
    );

    let sessionId = '';
    const events = await readEvents(response, (event) => {
      if (event.type === 'session') sessionId = event.sessionId as string;
      if (event.type === 'pending') {
        // The planner is called right after `pending`; let it start first.
        setTimeout(() => {
          void DELETE(new NextRequest(`http://localhost/api/enrich?sessionId=${sessionId}`, { method: 'DELETE' }));
        }, 50);
      }
    });

    expect(generate).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual(['session', 'pending', 'cancelled']);
    expect(toolCalls()).toBe(0);
  });

  it(
    'cancels on a client disconnect: no more tool or model calls, and the session is gone',
    { timeout: 60_000 },
    async () => {
      // The first search holds for three seconds, so the disconnect lands mid-call.
      searchMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(searchFixture), 3_000)));
      const modelCalls = watchModelCalls();

      let sessionId = '';
      let disconnected: Promise<void> | undefined;
      let callsAtCancel = 0;
      let modelCallsAtCancel = 0;

      const events = await readEvents(await post([{ email: 'hello@firecrawl.dev' }]), (event, reader) => {
        if (event.type === 'session') sessionId = event.sessionId as string;
        if (event.type === 'agent_progress' && String(event.message).startsWith('Searching the web') && !disconnected) {
          callsAtCancel = toolCalls();
          modelCallsAtCancel = modelCalls();
          disconnected = reader.cancel();
        }
      });
      await disconnected;

      expect(disconnected).toBeDefined();
      // The identify step reached the model before its search, so the watch sees model calls.
      expect(modelCallsAtCancel).toBeGreaterThan(0);
      expect(events.map((event) => event.type)).not.toContain('result');
      // The session was stopped the way a DELETE stops it, so it is gone.
      const response = await DELETE(new NextRequest(`http://localhost/api/enrich?sessionId=${sessionId}`, { method: 'DELETE' }));
      expect(response.status).toBe(404);

      // Nothing new is called after the disconnect, even once the held call settles.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(toolCalls()).toBe(callsAtCancel);
      expect(modelCalls()).toBe(modelCallsAtCancel);
    }
  );

  it(
    'cancels when the request signal aborts (a disconnect on Vercel): no more tool or model calls, and the session is gone',
    { timeout: 60_000 },
    async () => {
      // The first search holds for three seconds, so the abort lands mid-call.
      searchMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(searchFixture), 3_000)));
      const modelCalls = watchModelCalls();
      const client = new AbortController();

      let sessionId = '';
      let callsAtAbort = 0;
      let modelCallsAtAbort = 0;

      // The stream is still read to its end: only the request signal reports the disconnect.
      const events = await readEvents(await post([{ email: 'hello@firecrawl.dev' }], client.signal), (event) => {
        if (event.type === 'session') sessionId = event.sessionId as string;
        if (event.type === 'agent_progress' && String(event.message).startsWith('Searching the web') && !client.signal.aborted) {
          callsAtAbort = toolCalls();
          modelCallsAtAbort = modelCalls();
          client.abort();
        }
      });

      expect(client.signal.aborted).toBe(true);
      expect(modelCallsAtAbort).toBeGreaterThan(0);
      const types = events.map((event) => event.type);
      expect(types).toContain('cancelled');
      expect(types).not.toContain('result');
      expect(types).not.toContain('complete');
      expect(vi.mocked(console.log).mock.calls.filter(([line]) => String(line).includes('Client disconnected'))).toHaveLength(1);
      // The session was stopped the way a DELETE stops it, so it is gone.
      const response = await DELETE(new NextRequest(`http://localhost/api/enrich?sessionId=${sessionId}`, { method: 'DELETE' }));
      expect(response.status).toBe(404);

      // Nothing new is called after the abort, even once the held call settles.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(toolCalls()).toBe(callsAtAbort);
      expect(modelCalls()).toBe(modelCallsAtAbort);
    }
  );

  it('answers 404 to a DELETE for an unknown session', async () => {
    const response = await DELETE(new NextRequest('http://localhost/api/enrich?sessionId=missing', { method: 'DELETE' }));

    expect(response.status).toBe(404);
  });
});

/** DELETE the session as soon as the identify step's first (held) search starts. */
function cancelOnFirstSearch() {
  let sessionId = '';
  let cancelled = false;
  return (event: Event) => {
    if (event.type === 'session') sessionId = event.sessionId as string;
    if (event.type === 'agent_progress' && String(event.message).startsWith('Searching the web') && !cancelled) {
      cancelled = true;
      void DELETE(new NextRequest(`http://localhost/api/enrich?sessionId=${sessionId}`, { method: 'DELETE' }));
    }
  };
}

describe('POST /api/enrich run recording (lib/runs mocked)', () => {
  const warnings = (events: Event[]) =>
    events.filter((event) => event.type === 'agent_progress' && String(event.message).startsWith('run not recorded'));

  it(
    'starts the run with the resolved planId, records each row as shown, and commits before `complete`',
    { timeout: 120_000 },
    async () => {
      runs.doltConfigured.mockReturnValue(true);
      // The plan resolves from a saved row, so it carries that row's id.
      putPlan(PLAN, { planId: 'plan_saved' });

      const timeline: string[] = [];
      runs.finishRun.mockImplementation(async () => {
        timeline.push('finish:start');
        await new Promise((resolve) => setTimeout(resolve, 200));
        timeline.push('finish:end');
        return 'hash_1';
      });

      const events = await readEvents(await post([{ email: 'hello@firecrawl.dev' }]), (event) => timeline.push(event.type));

      expect(runs.startRun).toHaveBeenCalledOnce();
      expect(runs.startRun).toHaveBeenCalledWith({ planId: 'plan_saved', listRef: expect.stringMatching(/^emails:sha256:/) });

      // What is recorded is what the UI got: the citation-filtered values,
      // each with the strategy of the plan group that researched it.
      const { result } = events.find((event) => event.type === 'result') as unknown as {
        result: { enrichments: Record<string, unknown> };
      };
      expect(runs.recordRow).toHaveBeenCalledOnce();
      expect(runs.recordRow).toHaveBeenCalledWith('run_1', 'hello@firecrawl.dev', result.enrichments, {
        product_summary: 'search',
        homepage_headline: 'browser',
      });
      const recorded = runs.recordRow.mock.calls[0][2] as Record<string, { sourceContext?: Array<{ url: string }> }>;
      expect(recorded.product_summary.sourceContext?.map((context) => context.url)).toEqual(['https://www.firecrawl.dev/']);

      // Committed as completed, and only then is `complete` sent.
      expect(runs.finishRun).toHaveBeenCalledOnce();
      expect(runs.finishRun).toHaveBeenCalledWith('run_1', 'completed');
      expect(timeline.indexOf('complete')).toBeGreaterThan(timeline.indexOf('finish:end'));
      expect(warnings(events)).toEqual([]);
      // `complete` names the committed run the rows belong to.
      expect(events.at(-1)).toEqual({ type: 'complete', runId: 'run_1' });
    }
  );

  it('streams `runId: null` on `complete` when the run commit fails', { timeout: 120_000 }, async () => {
    runs.doltConfigured.mockReturnValue(true);
    runs.finishRun.mockRejectedValue(new Error('merge conflicted'));

    const events = await readEvents(await post([{ email: 'hello@firecrawl.dev' }]));

    expect(runs.finishRun).toHaveBeenCalledOnce();
    expect(events.at(-1)).toEqual({ type: 'complete', runId: null });
  });

  it('does not start a run before the plan resolves: a cancel during planning records nothing', { timeout: 30_000 }, async () => {
    runs.doltConfigured.mockReturnValue(true);
    const planner = mastra.getAgent('planner');
    vi.spyOn(planner, 'generate').mockImplementation(((_message: unknown, options?: { abortSignal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })) as unknown as typeof planner.generate);

    const uncached = [{ name: 'uncached_field', displayName: 'Uncached Field', description: 'x', type: 'string', required: false }];
    const response = await POST(
      new NextRequest('http://localhost/api/enrich', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rows: [{ email: 'hello@firecrawl.dev' }], fields: uncached, emailColumn: 'email' }),
      })
    );
    let sessionId = '';
    const events = await readEvents(response, (event) => {
      if (event.type === 'session') sessionId = event.sessionId as string;
      if (event.type === 'pending') {
        setTimeout(() => void DELETE(new NextRequest(`http://localhost/api/enrich?sessionId=${sessionId}`, { method: 'DELETE' })), 50);
      }
    });

    expect(events.map((event) => event.type)).toEqual(['session', 'pending', 'cancelled']);
    expect(runs.startRun).not.toHaveBeenCalled();
    expect(runs.finishRun).not.toHaveBeenCalled();
  });

  it('commits a cancelled session as `partial`, with a null planId for an unsaved plan', { timeout: 60_000 }, async () => {
    runs.doltConfigured.mockReturnValue(true);
    searchMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(searchFixture), 10_000)));

    const events = await readEvents(await post([{ email: 'hello@firecrawl.dev' }]), cancelOnFirstSearch());

    expect(events.map((event) => event.type)).toContain('cancelled');
    // The cached plan has no saved row behind it.
    expect(runs.startRun).toHaveBeenCalledWith({ planId: null, listRef: expect.any(String) });
    expect(runs.recordRow).not.toHaveBeenCalled();
    expect(runs.finishRun).toHaveBeenCalledOnce();
    expect(runs.finishRun).toHaveBeenCalledWith('run_1', 'partial');
  });

  it('commits a session stopped by a client disconnect as `partial`, with the rows that finished', { timeout: 120_000 }, async () => {
    runs.doltConfigured.mockReturnValue(true);
    // One row at a time, so the first row finishes before the second starts.
    const config = ENRICHMENT_CONFIG as { MASTRA_CONCURRENT_ROWS: number };
    const concurrency = config.MASTRA_CONCURRENT_ROWS;
    config.MASTRA_CONCURRENT_ROWS = 1;
    // Searches answer until the first row is recorded, then hold.
    searchMock.mockImplementation(() =>
      runs.recordRow.mock.calls.length > 0
        ? new Promise((resolve) => setTimeout(() => resolve(searchFixture), 10_000))
        : Promise.resolve(searchFixture)
    );

    try {
      let finished = false;
      let disconnected: Promise<void> | undefined;
      const events = await readEvents(
        await post([{ email: 'hello@firecrawl.dev' }, { email: 'hello@firecrawl.dev' }]),
        (event, reader) => {
          if (event.type === 'result') finished = true;
          if (finished && event.type === 'agent_progress' && String(event.message).startsWith('Searching the web') && !disconnected) {
            disconnected = reader.cancel();
          }
        }
      );
      await disconnected;

      expect(disconnected).toBeDefined();
      expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
      // The run is committed after the stopped row settles, with no client left to tell.
      await vi.waitFor(() => expect(runs.finishRun).toHaveBeenCalledOnce(), { timeout: 20_000 });
      expect(runs.finishRun).toHaveBeenCalledWith('run_1', 'partial');
      expect(runs.recordRow).toHaveBeenCalledOnce();
    } finally {
      config.MASTRA_CONCURRENT_ROWS = concurrency;
    }
  });

  it(
    'commits a session stopped by a request signal abort as `partial`, and keeps the function alive until then',
    { timeout: 120_000 },
    async () => {
      runs.doltConfigured.mockReturnValue(true);
      // One row at a time, so the first row finishes before the second starts.
      const config = ENRICHMENT_CONFIG as { MASTRA_CONCURRENT_ROWS: number };
      const concurrency = config.MASTRA_CONCURRENT_ROWS;
      config.MASTRA_CONCURRENT_ROWS = 1;
      // Searches answer until the first row is recorded, then hold.
      searchMock.mockImplementation(() =>
        runs.recordRow.mock.calls.length > 0
          ? new Promise((resolve) => setTimeout(() => resolve(searchFixture), 10_000))
          : Promise.resolve(searchFixture)
      );
      const timeline: string[] = [];
      runs.finishRun.mockImplementation(async () => {
        timeline.push('finish');
        return 'hash_1';
      });

      try {
        const client = new AbortController();
        let finished = false;
        const response = await post([{ email: 'hello@firecrawl.dev' }, { email: 'hello@firecrawl.dev' }], client.signal);
        // The session is handed to `after`, which keeps a cancelled Vercel function alive.
        const kept = vi.mocked(after).mock.calls.at(-1)?.[0] as Promise<void>;
        expect(kept).toBeInstanceOf(Promise);
        void kept.then(() => timeline.push('session ended'));

        const events = await readEvents(response, (event) => {
          if (event.type === 'result') finished = true;
          if (finished && event.type === 'agent_progress' && String(event.message).startsWith('Searching the web') && !client.signal.aborted) {
            client.abort();
          }
        });
        await kept;

        expect(client.signal.aborted).toBe(true);
        expect(events.filter((event) => event.type === 'result')).toHaveLength(1);
        expect(events.map((event) => event.type)).toContain('cancelled');
        expect(runs.finishRun).toHaveBeenCalledOnce();
        expect(runs.finishRun).toHaveBeenCalledWith('run_1', 'partial');
        expect(runs.recordRow).toHaveBeenCalledOnce();
        // The kept-alive promise settles only once the run is committed.
        expect(timeline).toEqual(['finish', 'session ended']);
      } finally {
        config.MASTRA_CONCURRENT_ROWS = concurrency;
      }
    }
  );

  it('commits a session that fails part-way as `failed`', { timeout: 30_000 }, async () => {
    runs.doltConfigured.mockReturnValue(true);

    // A null row throws in the row loop, outside the per-row error handling,
    // which fails the session after its run has started.
    const response = await POST(
      new NextRequest('http://localhost/api/enrich', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rows: [null], fields: FIELDS, emailColumn: 'email', listRef: 'contacts.csv' }),
      })
    );
    const events = await readEvents(response);

    expect(events.map((event) => event.type)).toContain('error');
    expect(runs.startRun).toHaveBeenCalledWith({ planId: null, listRef: 'contacts.csv' });
    expect(runs.finishRun).toHaveBeenCalledOnce();
    expect(runs.finishRun).toHaveBeenCalledWith('run_1', 'failed');
  });

  it('streams one generic warning when the run cannot be recorded, and enriches every row', { timeout: 120_000 }, async () => {
    runs.doltConfigured.mockReturnValue(true);
    runs.startRun.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3316'), { code: 'ECONNREFUSED' }));

    const events = await readEvents(await post([{ email: 'hello@firecrawl.dev' }, { email: 'hello@firecrawl.dev' }]));

    expect(warnings(events)).toHaveLength(1);
    expect(warnings(events)[0]).toMatchObject({ message: 'run not recorded: storage unavailable', messageType: 'warning' });
    // The driver error never reaches the browser.
    expect(JSON.stringify(events)).not.toMatch(/ECONNREFUSED|3316/);
    const results = events.filter((event) => event.type === 'result') as unknown as Array<{ result: { status: string } }>;
    expect(results.map(({ result }) => result.status)).toEqual(['completed', 'completed']);
    expect(events.at(-1)).toEqual({ type: 'complete', runId: null });
    expect(runs.recordRow).not.toHaveBeenCalled();
    expect(runs.finishRun).not.toHaveBeenCalled();
  });
});
