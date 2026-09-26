/**
 * `POST /api/chat` and `DELETE /api/chat` through the route handler.
 *
 * The chat agent's model calls are answered by AIMock from
 * `fixtures/chat-answer.json`, and Firecrawl is mocked at the SDK boundary on
 * the recordings in `tests/fixtures/firecrawl/`. The assertions are on the
 * event stream the chat panel reads (`app/fire-enrich/enrichment-table.tsx`):
 * `status` lines while the agent works, one `response` with its `message` and
 * `source`, then `complete`.
 *
 * Requires AIMock on `AIMOCK_URL` (`npm run test:ai` starts it).
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  },
}));

import { DELETE, POST } from '@/app/api/chat/route';

import { AIMOCK_URL } from '../aimock';
import { watchTraceFlush } from '../trace-flush';

/** The table as the panel formats it. */
const CONTEXT = {
  emailColumn: 'email',
  fields: [{ name: 'product_summary', displayName: 'Product Summary' }],
  totalRows: 1,
  processedRows: 1,
  tableData:
    'Enriched Data Table:\nRow 1 (hello@firecrawl.dev): product_summary: "The web data API to search, scrape, and interact at scale."\n\nTotal: 1 rows with data',
};

type Event = { type: string; [key: string]: unknown };

function post(question: string, sessionId?: string): Promise<Response> {
  return POST(
    new NextRequest('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, context: CONTEXT, conversationHistory: [], sessionId }),
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

beforeAll(async () => {
  const health = await fetch(`${AIMOCK_URL}/health`).catch(() => undefined);
  if (!health?.ok) throw new Error(`AIMock is not reachable at ${AIMOCK_URL}.`);
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  searchMock.mockResolvedValue(searchFixture);
  scrapeMock.mockResolvedValue(scrapeFixture);
});

afterEach(() => {
  vi.restoreAllMocks();
  searchMock.mockReset();
  scrapeMock.mockReset();
});

describe('POST /api/chat', () => {
  it('answers from the table without a tool call', { timeout: 30_000 }, async () => {
    const events = await readEvents(await post('What does Firecrawl do according to the table?'));

    expect(events).toEqual([
      { type: 'status', message: 'Checking enriched table data...', step: 'table_check' },
      {
        type: 'response',
        message:
          'According to the table, Firecrawl offers a web data API to search, scrape, and interact with the web at scale.',
        source: { type: 'table', title: 'Enriched Data Table' },
      },
      { type: 'complete' },
    ]);
    expect(searchMock).not.toHaveBeenCalled();
    expect(scrapeMock).not.toHaveBeenCalled();
  });

  it('writes the agent trace spans in after(), once the stream has ended', { timeout: 30_000 }, async () => {
    const runAfterTasks = watchTraceFlush();
    const events = await readEvents(await post('What does Firecrawl do according to the table?'));
    expect(events.at(-1)).toEqual({ type: 'complete' });
    await runAfterTasks();
  });

  it('searches the web and, without a scrape, cites no search hit', { timeout: 30_000 }, async () => {
    const events = await readEvents(await post('What does the Firecrawl homepage headline say?'));

    expect(events).toEqual([
      { type: 'status', message: 'Checking enriched table data...', step: 'table_check' },
      { type: 'status', message: 'Searching the web for "Firecrawl homepage headline"...', step: 'search' },
      { type: 'status', message: 'Found 2 sources', step: 'select' },
      {
        type: 'status',
        message: 'Reading https://www.firecrawl.dev/',
        step: 'scrape',
        source: { url: 'https://www.firecrawl.dev/', title: 'Firecrawl' },
      },
      {
        type: 'status',
        message: 'Reading https://github.com/firecrawl/firecrawl',
        step: 'scrape',
        source: {
          url: 'https://github.com/firecrawl/firecrawl',
          title: 'GitHub - firecrawl/firecrawl: The web data API to search, scrape, and ...',
        },
      },
      {
        type: 'response',
        message: 'The Firecrawl homepage headline reads "Power AI agents with clean web data".',
        source: { type: 'table', title: 'Enriched Data Table' },
      },
      { type: 'complete' },
    ]);
    // Nothing was scraped, so no search hit is cited as the source.
    const hits = new Set(events.filter((event) => event.step === 'scrape').map((event) => (event.source as { url: string }).url));
    const response = events.find((event) => event.type === 'response');
    expect(hits.has((response?.source as { url?: string }).url ?? '')).toBe(false);
    expect(searchMock).toHaveBeenCalledOnce();
    expect(searchMock.mock.calls[0][0]).toBe('Firecrawl homepage headline');
    expect(scrapeMock).not.toHaveBeenCalled();
  });

  it('cites the page it scraped', { timeout: 30_000 }, async () => {
    const events = await readEvents(await post('What does the Firecrawl homepage say it is?'));
    const source = {
      url: 'https://www.firecrawl.dev/',
      title: 'Firecrawl - The web data API to search, scrape, and interact with the web at scale. 🔥',
    };

    expect(events).toEqual([
      { type: 'status', message: 'Checking enriched table data...', step: 'table_check' },
      { type: 'status', message: 'Reading https://www.firecrawl.dev/', step: 'scrape', source },
      {
        type: 'response',
        message: 'The Firecrawl homepage calls it the web data API to search, scrape, and interact with the web at scale.',
        source,
      },
      { type: 'complete' },
    ]);
    expect(scrapeMock).toHaveBeenCalledOnce();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('answers 400 to an empty question', async () => {
    const response = await post('   ');

    expect(response.status).toBe(400);
  });
});

describe('DELETE /api/chat', () => {
  it('stops a running query: no response, no error, and the stream ends', { timeout: 30_000 }, async () => {
    // The search holds until the query is stopped, as a slow Firecrawl call would.
    searchMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(searchFixture), 10_000)));

    const queryId = 'chat-test-query';
    let stopped: Response | undefined;
    const started = Date.now();

    const events = await readEvents(await post('What does the Firecrawl homepage headline say?', queryId), (event) => {
      if (event.step === 'search' && !stopped) {
        void DELETE(new NextRequest(`http://localhost/api/chat?queryId=${queryId}`, { method: 'DELETE' })).then(
          (response) => {
            stopped = response;
          }
        );
      }
    });

    expect(stopped?.status).toBe(200);
    expect(await stopped?.json()).toEqual({ success: true });
    expect(events.map((event) => event.type)).toEqual(['status', 'status']);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it('answers 404 to an unknown query and 400 without an id', async () => {
    const unknown = await DELETE(new NextRequest('http://localhost/api/chat?queryId=missing', { method: 'DELETE' }));
    const missing = await DELETE(new NextRequest('http://localhost/api/chat', { method: 'DELETE' }));

    expect(unknown.status).toBe(404);
    expect(missing.status).toBe(400);
  });
});
