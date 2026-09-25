import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rate limiting on /api/scrape is optional: it is applied only when one
 * complete credential pair is set, UPSTASH_REDIS_REST_URL/TOKEN or
 * KV_REST_API_URL/TOKEN (the names Vercel's Upstash integration injects).
 *
 * Before this was so, a production build without them still called
 * `Redis.fromEnv()`, which only warns, and the first `limit()` call then threw
 * `TypeError: Failed to parse URL from /pipeline`, so every scrape failed.
 *
 * Upstash and the Firecrawl SDK are mocked at the module boundary; nothing
 * reaches the network.
 */
const { ratelimitCtor, limitMock, fixedWindowMock, redisCtor, scrapeMock } = vi.hoisted(() => ({
  ratelimitCtor: vi.fn(),
  limitMock: vi.fn(),
  fixedWindowMock: vi.fn(() => 'fixed-window'),
  redisCtor: vi.fn(),
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
  Redis: class {
    constructor(...args: unknown[]) {
      redisCtor(...args);
    }
  },
}));

vi.mock('firecrawl', () => ({
  Firecrawl: class {
    scrape = scrapeMock;
    batchScrape = vi.fn();
  },
}));

const UPSTASH = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'] as const;
const KV = ['KV_REST_API_URL', 'KV_REST_API_TOKEN'] as const;
const ALL = [...UPSTASH, ...KV];

/** A distinct value per variable, so a test can tell which pair reached Redis. */
const valueFor = (name: string) => (name.endsWith('URL') ? `https://${name}.upstash.io` : `token-${name}`);

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
  for (const name of ALL) vi.stubEnv(name, undefined);
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

    expect(redisCtor).not.toHaveBeenCalled();
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

  it.each(ALL)('stays off when only %s is set', async (name) => {
    vi.stubEnv(name, valueFor(name));
    const scrape = await loadScrape();

    const res = await scrape(scrapeRequest());

    expect(res.status).toBe(200);
    expect(ratelimitCtor).not.toHaveBeenCalled();
  });

  it.each([
    ['UPSTASH_REDIS_REST_URL', 'KV_REST_API_TOKEN'],
    ['KV_REST_API_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ])('stays off with a mixed pair, %s and %s', async (url, token) => {
    vi.stubEnv(url, valueFor(url));
    vi.stubEnv(token, valueFor(token));
    const scrape = await loadScrape();

    const res = await scrape(scrapeRequest());

    expect(res.status).toBe(200);
    expect(redisCtor).not.toHaveBeenCalled();
    expect(ratelimitCtor).not.toHaveBeenCalled();
  });
});

describe('/api/scrape with the KV_* pair only', () => {
  beforeEach(() => {
    for (const name of KV) vi.stubEnv(name, valueFor(name));
  });

  it('applies the limiter with the KV credentials', async () => {
    limitMock.mockResolvedValue({ success: false, limit: 50, remaining: 0 });
    const scrape = await loadScrape();

    const res = await scrape(scrapeRequest());

    expect(res.status).toBe(429);
    expect(redisCtor).toHaveBeenCalledWith({
      url: valueFor('KV_REST_API_URL'),
      token: valueFor('KV_REST_API_TOKEN'),
    });
    expect(limitMock).toHaveBeenCalledWith('203.0.113.7');
    expect(scrapeMock).not.toHaveBeenCalled();
  });

  it('never pairs a stray UPSTASH_* variable with the KV pair', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', valueFor('UPSTASH_REDIS_REST_URL'));
    limitMock.mockResolvedValue({ success: true, limit: 50, remaining: 49 });
    const scrape = await loadScrape();

    await scrape(scrapeRequest());

    expect(redisCtor).toHaveBeenCalledWith({
      url: valueFor('KV_REST_API_URL'),
      token: valueFor('KV_REST_API_TOKEN'),
    });
  });
});

describe('/api/scrape with Upstash configured', () => {
  beforeEach(() => {
    for (const name of UPSTASH) vi.stubEnv(name, valueFor(name));
  });

  it('applies the 50-per-day limiter keyed on the client IP', async () => {
    limitMock.mockResolvedValue({ success: true, limit: 50, remaining: 49 });
    const scrape = await loadScrape();

    const res = await scrape(scrapeRequest());

    expect(res.status).toBe(200);
    expect(redisCtor).toHaveBeenCalledWith({
      url: valueFor('UPSTASH_REDIS_REST_URL'),
      token: valueFor('UPSTASH_REDIS_REST_TOKEN'),
    });
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
