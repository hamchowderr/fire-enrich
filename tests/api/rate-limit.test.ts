import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rate limiting on /api/scrape is optional: it is applied only when both
 * UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set.
 *
 * Before this was so, a production build without them still called
 * `Redis.fromEnv()`, which only warns, and the first `limit()` call then threw
 * `TypeError: Failed to parse URL from /pipeline`, so every scrape failed.
 *
 * Upstash and the Firecrawl SDK are mocked at the module boundary; nothing
 * reaches the network.
 */
const { ratelimitCtor, limitMock, fixedWindowMock, fromEnvMock, scrapeMock } = vi.hoisted(() => ({
  ratelimitCtor: vi.fn(),
  limitMock: vi.fn(),
  fixedWindowMock: vi.fn(() => 'fixed-window'),
  fromEnvMock: vi.fn(() => ({ redis: true })),
  scrapeMock: vi.fn(),
}));

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: Object.assign(
    class {
      constructor(...args: unknown[]) {
        ratelimitCtor(...args);
      }
      limit = limitMock;
    },
    { fixedWindow: fixedWindowMock },
  ),
}));

vi.mock('@upstash/redis', () => ({
  Redis: { fromEnv: fromEnvMock },
}));

vi.mock('firecrawl', () => ({
  Firecrawl: class {
    scrape = scrapeMock;
    batchScrape = vi.fn();
  },
}));

const UPSTASH = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;

function scrapeRequest() {
  return new NextRequest('http://localhost/api/scrape', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify({ url: 'https://firecrawl.dev' }),
  });
}

/** Imports the route fresh, so the once-only log starts unset in every test. */
async function loadScrape() {
  vi.resetModules();
  return (await import('@/app/api/scrape/route')).POST;
}

let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production');
  for (const name of UPSTASH) vi.stubEnv(name, undefined);
  scrapeMock.mockResolvedValue({ markdown: '# Firecrawl' });
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  infoSpy.mockRestore();
});

describe('/api/scrape without Upstash', () => {
  it('serves the scrape in production and never builds a limiter', async () => {
    const scrape = await loadScrape();

    for (let i = 0; i < 3; i++) {
      const res = await scrape(scrapeRequest());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, data: { markdown: '# Firecrawl' } });
    }

    expect(fromEnvMock).not.toHaveBeenCalled();
    expect(ratelimitCtor).not.toHaveBeenCalled();
    expect(limitMock).not.toHaveBeenCalled();
  });

  it('logs one info line, however many requests arrive', async () => {
    const scrape = await loadScrape();

    await scrape(scrapeRequest());
    await scrape(scrapeRequest());

    const lines = infoSpy.mock.calls.filter(([msg]) => String(msg).includes('rate limiting is off'));
    expect(lines).toHaveLength(1);
  });

  it.each(UPSTASH)('stays off when only %s is set', async (name) => {
    vi.stubEnv(name, name.endsWith('URL') ? 'https://example.upstash.io' : 'token');
    const scrape = await loadScrape();

    const res = await scrape(scrapeRequest());

    expect(res.status).toBe(200);
    expect(ratelimitCtor).not.toHaveBeenCalled();
  });
});

describe('/api/scrape with Upstash configured', () => {
  beforeEach(() => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'token');
  });

  it('applies the 50-per-day limiter keyed on the client IP', async () => {
    limitMock.mockResolvedValue({ success: true, limit: 50, remaining: 49 });
    const scrape = await loadScrape();

    const res = await scrape(scrapeRequest());

    expect(res.status).toBe(200);
    expect(fromEnvMock).toHaveBeenCalledTimes(1);
    expect(fixedWindowMock).toHaveBeenCalledWith(50, '1 d');
    expect(ratelimitCtor).toHaveBeenCalledWith(
      expect.objectContaining({ limiter: 'fixed-window', prefix: 'ratelimit:scrape' }),
    );
    expect(limitMock).toHaveBeenCalledWith('203.0.113.7');
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('answers 429 with the limit headers once the limit is spent', async () => {
    limitMock.mockResolvedValue({ success: false, limit: 50, remaining: 0 });
    const scrape = await loadScrape();

    const res = await scrape(scrapeRequest());

    expect(res.status).toBe(429);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('50');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(scrapeMock).not.toHaveBeenCalled();
  });
});
