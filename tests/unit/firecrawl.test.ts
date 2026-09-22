import type { AgentStatusResponse, Document, SearchData } from 'firecrawl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import agentFixture from '../fixtures/firecrawl/agent.json';
import scrapeFixture from '../fixtures/firecrawl/scrape.json';
import searchFixture from '../fixtures/firecrawl/search.json';

/**
 * The Firecrawl SDK is mocked at the tool boundary: `search()` and `scrape()`
 * return the recorded responses under `tests/fixtures/firecrawl/`, so the
 * adapter's mapping, retry, and error behaviour is exercised without a key or
 * a network call.
 */
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

// Imported after the mock is declared; `vi.mock` is hoisted above imports.
import { FirecrawlService } from '@/lib/services/firecrawl';

const recordedSearch = searchFixture as SearchData;
const recordedScrape = scrapeFixture as Document;

function apiError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

let service: FirecrawlService;

beforeEach(() => {
  service = new FirecrawlService('stub');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  searchMock.mockReset();
  scrapeMock.mockReset();
});

describe('FirecrawlService.search', () => {
  it('maps the recorded search response onto SearchResult', async () => {
    searchMock.mockResolvedValueOnce(recordedSearch);

    const results = await service.search('firecrawl web scraping api', { limit: 2 });

    expect(searchMock).toHaveBeenCalledWith('firecrawl web scraping api', {
      limit: 2,
      scrapeOptions: { formats: ['markdown', 'links', 'html'] },
    });
    expect(results).toHaveLength(2);

    const [first] = searchFixture.web;
    expect(results[0]).toEqual({
      url: first.url,
      title: first.title,
      description: first.description,
      markdown: first.markdown,
      html: first.html,
      links: first.links,
      metadata: first.metadata,
    });
    expect(results[1].url).toBe(searchFixture.web[1].url);
  });

  it('falls back to metadata when a result carries no top-level fields', async () => {
    searchMock.mockResolvedValueOnce({
      web: [
        { metadata: { sourceURL: 'https://a.example', title: 'A', description: 'From metadata' } },
        { metadata: { url: 'https://b.example' } },
        {},
      ],
    });

    const results = await service.search('anything');

    expect(results.map((r) => r.url)).toEqual(['https://a.example', 'https://b.example', '']);
    expect(results[0]).toMatchObject({ title: 'A', description: 'From metadata' });
    expect(results[2]).toMatchObject({ title: '', description: '' });
  });

  it('uses a limit of 5 and scrapes content by default', async () => {
    searchMock.mockResolvedValueOnce({ web: [] });

    await service.search('defaults');

    expect(searchMock).toHaveBeenCalledWith('defaults', {
      limit: 5,
      scrapeOptions: { formats: ['markdown', 'links', 'html'] },
    });
  });

  it('omits scrapeOptions when scrapeContent is false', async () => {
    searchMock.mockResolvedValueOnce({ web: [] });

    await service.search('no scrape', { limit: 3, scrapeContent: false });

    expect(searchMock).toHaveBeenCalledWith('no scrape', { limit: 3 });
  });

  it('returns an empty list when the response has no web results', async () => {
    searchMock.mockResolvedValueOnce({});

    await expect(service.search('empty')).resolves.toEqual([]);
  });

  it('retries with exponential backoff on 429 and returns the eventual results', async () => {
    vi.useFakeTimers();
    searchMock
      .mockRejectedValueOnce(apiError(429, 'Rate limited'))
      .mockRejectedValueOnce(apiError(503, 'Unavailable'))
      .mockResolvedValueOnce(recordedSearch);

    const pending = service.search('retry me');
    await vi.runAllTimersAsync();
    const results = await pending;

    expect(searchMock).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(2);
  });

  it('returns an empty list without retrying on a non-retryable error', async () => {
    searchMock.mockRejectedValueOnce(apiError(401, 'Unauthorized'));

    await expect(service.search('bad key')).resolves.toEqual([]);
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up with an empty list after three retryable failures', async () => {
    vi.useFakeTimers();
    searchMock.mockRejectedValue(apiError(502, 'Bad gateway'));

    const pending = service.search('always failing');
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual([]);
    expect(searchMock).toHaveBeenCalledTimes(3);
  });
});

describe('FirecrawlService.scrapeUrl', () => {
  it('returns markdown and html from the recorded scrape', async () => {
    scrapeMock.mockResolvedValueOnce(recordedScrape);

    const result = await service.scrapeUrl('https://firecrawl.dev');

    expect(scrapeMock).toHaveBeenCalledWith('https://firecrawl.dev', {
      formats: ['markdown', 'html'],
      timeout: 30000,
    });
    expect(result).toEqual({
      data: { markdown: scrapeFixture.markdown, html: scrapeFixture.html },
    });
    expect(result.data?.markdown).toContain('Firecrawl');
  });

  it('prefixes https:// when the url has no scheme', async () => {
    scrapeMock.mockResolvedValueOnce(recordedScrape);

    await service.scrapeUrl('firecrawl.dev');

    expect(scrapeMock.mock.calls[0][0]).toBe('https://firecrawl.dev');
  });

  it('retries once with skipTlsVerification on an SSL error', async () => {
    scrapeMock
      .mockRejectedValueOnce(new Error('SSL error: unable to verify the first certificate'))
      .mockResolvedValueOnce(recordedScrape);

    const result = await service.scrapeUrl('https://self-signed.example');

    expect(scrapeMock).toHaveBeenCalledTimes(2);
    expect(scrapeMock.mock.calls[1][1]).toMatchObject({ skipTlsVerification: true });
    expect(result.data?.markdown).toBe(scrapeFixture.markdown);
  });

  it('retries with backoff on a 502 and succeeds', async () => {
    vi.useFakeTimers();
    scrapeMock.mockRejectedValueOnce(apiError(502)).mockResolvedValueOnce(recordedScrape);

    const pending = service.scrapeUrl('https://flaky.example');
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({
      data: { markdown: scrapeFixture.markdown, html: scrapeFixture.html },
    });
    expect(scrapeMock).toHaveBeenCalledTimes(2);
  });

  it('treats network errors as retryable', async () => {
    vi.useFakeTimers();
    scrapeMock
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(recordedScrape);

    const pending = service.scrapeUrl('https://offline.example');
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toHaveProperty('data');
    expect(scrapeMock).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on a non-retryable error', async () => {
    scrapeMock.mockRejectedValueOnce(apiError(404, 'Not found'));

    await expect(service.scrapeUrl('https://missing.example')).rejects.toThrow('Not found');
    expect(scrapeMock).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after three retryable failures', async () => {
    vi.useFakeTimers();
    scrapeMock.mockRejectedValue(apiError(503, 'Unavailable'));

    const pending = service.scrapeUrl('https://down.example');
    // Attach the rejection handler before the timers run so the final throw
    // is observed rather than reported as unhandled.
    const outcome = expect(pending).rejects.toThrow('Unavailable');
    await vi.runAllTimersAsync();

    await outcome;
    expect(scrapeMock).toHaveBeenCalledTimes(3);
  });
});

describe('recorded fixtures', () => {
  it('agent.json is shaped like the SDK AgentStatusResponse', () => {
    const status = agentFixture as AgentStatusResponse;

    expect(status.success).toBe(true);
    expect(['processing', 'completed', 'failed']).toContain(status.status);
    expect(typeof status.expiresAt).toBe('string');
    expect(status.data).toMatchObject({ company: 'Firecrawl' });
  });

  it('search.json and scrape.json carry the fields the adapter reads', () => {
    for (const item of searchFixture.web) {
      expect(item).toMatchObject({
        url: expect.any(String),
        title: expect.any(String),
        markdown: expect.any(String),
        html: expect.any(String),
        links: expect.any(Array),
      });
    }
    // `sourceURL` is the url that was requested; `url` is where the engine landed.
    expect(scrapeFixture.metadata.sourceURL).toBe('https://firecrawl.dev');
    expect(scrapeFixture.metadata.url).toBe('https://www.firecrawl.dev/');
  });
});
