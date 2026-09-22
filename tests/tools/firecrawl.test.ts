/**
 * Tier-1 Firecrawl tools, driven against the recordings in
 * `tests/fixtures/firecrawl/`.
 *
 * The SDK is mocked at its own boundary, so what is under test is everything
 * the tools add on top of it: the trimming that keeps one page from filling the
 * context, the retry ported from `FirecrawlService`, the blocked-domain filter
 * lifted out of the orchestrator, the progress events an SSE adapter will
 * render, and cancellation — which the SDK cannot do, so the tools do it by
 * racing the signal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import mapFixture from '../fixtures/firecrawl/map.json';
import scrapeFixture from '../fixtures/firecrawl/scrape.json';
import searchFixture from '../fixtures/firecrawl/search.json';

import { apiError, never, progressEvents, recordingWriter, runTool } from './helpers';

const { searchMock, scrapeMock, mapMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
  scrapeMock: vi.fn(),
  mapMock: vi.fn(),
}));

vi.mock('firecrawl', () => ({
  Firecrawl: class {
    search = searchMock;
    scrape = scrapeMock;
    map = mapMock;
  },
}));

// Imported after the mock is declared; `vi.mock` is hoisted above imports.
import { mapTool, scrapeTool, searchTool } from '@/lib/mastra/tools/firecrawl';

interface SearchOutput {
  query: string;
  results: Array<{ url: string; title: string; description: string; markdown: string; truncated: boolean }>;
  blockedCount: number;
  truncated: boolean;
}

interface ScrapeOutput {
  url: string;
  blocked: boolean;
  reason?: string;
  title?: string;
  markdown: string;
  truncated: boolean;
}

interface MapOutput {
  url: string;
  links: Array<{ url: string; title?: string }>;
  blockedCount: number;
  truncated: boolean;
}

/** A search response with `count` results, each carrying `size` characters of markdown. */
function longSearchResponse(count: number, size: number) {
  return {
    web: Array.from({ length: count }, (_, index) => ({
      url: `https://acme.example/page-${index}`,
      title: `Page ${index}`,
      description: 'A long page',
      markdown: 'x'.repeat(size),
    })),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  searchMock.mockReset();
  scrapeMock.mockReset();
  mapMock.mockReset();
});

describe('searchTool', () => {
  it('maps the recorded response and asks for markdown only', async () => {
    searchMock.mockResolvedValueOnce(searchFixture);

    const result = await runTool<{ query: string }, SearchOutput>(searchTool, {
      query: 'firecrawl web scraping api',
    });

    expect(searchMock).toHaveBeenCalledWith('firecrawl web scraping api', {
      limit: 5,
      scrapeOptions: { formats: ['markdown'] },
    });
    expect(result.query).toBe('firecrawl web scraping api');
    expect(result.results).toHaveLength(searchFixture.web.length);
    expect(result.results[0].url).toBe(searchFixture.web[0].url);
    expect(result.results[0].markdown).toContain('Firecrawl');
  });

  it('falls back to metadata for a result with no top-level fields', async () => {
    searchMock.mockResolvedValueOnce({
      web: [{ metadata: { sourceURL: 'https://a.example', title: 'A', description: 'From metadata' } }],
    });

    const result = await runTool<{ query: string }, SearchOutput>(searchTool, { query: 'anything' });

    expect(result.results[0]).toMatchObject({
      url: 'https://a.example',
      title: 'A',
      description: 'From metadata',
    });
  });

  it('omits scrapeOptions and honours a custom limit', async () => {
    searchMock.mockResolvedValueOnce({ web: [] });

    await runTool(searchTool, { query: 'cheap', limit: 3, scrapeContent: false });

    expect(searchMock).toHaveBeenCalledWith('cheap', { limit: 3 });
  });

  it('splits one content budget evenly so the top hit cannot eat it all', async () => {
    searchMock.mockResolvedValueOnce(longSearchResponse(4, 10_000));

    const result = await runTool<{ query: string }, SearchOutput>(searchTool, { query: 'long pages' });

    const total = result.results.reduce((sum, item) => sum + item.markdown.length, 0);
    expect(total).toBeLessThanOrEqual(8_000);
    // Evenly shared: four results, 2_000 characters each.
    expect(result.results.map((item) => item.markdown.length)).toEqual([2_000, 2_000, 2_000, 2_000]);
    expect(result.results.every((item) => item.truncated)).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('leaves a page that fits untrimmed', async () => {
    searchMock.mockResolvedValueOnce(longSearchResponse(1, 100));

    const result = await runTool<{ query: string }, SearchOutput>(searchTool, { query: 'short' });

    expect(result.results[0].markdown).toHaveLength(100);
    expect(result.truncated).toBe(false);
  });

  it('drops blocked domains and reports how many it dropped', async () => {
    searchMock.mockResolvedValueOnce({
      web: [
        { url: 'https://acme.example/about', title: 'About', markdown: 'real' },
        { url: 'https://www.linkedin.com/company/acme', title: 'LinkedIn', markdown: 'wall' },
        { url: 'https://x.com/acme', title: 'X', markdown: 'wall' },
      ],
    });

    const result = await runTool<{ query: string }, SearchOutput>(searchTool, { query: 'acme' });

    expect(result.results.map((item) => item.url)).toEqual(['https://acme.example/about']);
    expect(result.blockedCount).toBe(2);
  });

  it('writes one progress event for the query and one per source read', async () => {
    searchMock.mockResolvedValueOnce({
      web: [{ url: 'https://acme.example/a', title: 'A', markdown: 'a' }],
    });
    const writer = recordingWriter();

    await runTool(searchTool, { query: 'acme pricing' }, { writer: writer as never });

    expect(progressEvents(writer)).toEqual([
      { type: 'firecrawl-progress', message: 'Searching the web for: acme pricing' },
      { type: 'firecrawl-progress', message: 'Read: A', sourceUrl: 'https://acme.example/a' },
    ]);
  });

  it('retries a transient failure with exponential backoff', async () => {
    vi.useFakeTimers();
    searchMock
      .mockRejectedValueOnce(apiError(429, 'Rate limited'))
      .mockRejectedValueOnce(apiError(503, 'Unavailable'))
      .mockResolvedValueOnce(searchFixture);

    const pending = runTool<{ query: string }, SearchOutput>(searchTool, { query: 'retry me' });
    await vi.runAllTimersAsync();

    expect((await pending).results).toHaveLength(searchFixture.web.length);
    expect(searchMock).toHaveBeenCalledTimes(3);
  });

  it('throws rather than reporting an empty web after three transient failures', async () => {
    vi.useFakeTimers();
    searchMock.mockRejectedValue(apiError(502, 'Bad gateway'));

    const pending = runTool(searchTool, { query: 'always failing' });
    const outcome = expect(pending).rejects.toThrow('Bad gateway');
    await vi.runAllTimersAsync();

    await outcome;
    expect(searchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-retryable error', async () => {
    searchMock.mockRejectedValueOnce(apiError(401, 'Unauthorized'));

    await expect(runTool(searchTool, { query: 'bad key' })).rejects.toThrow('Unauthorized');
    expect(searchMock).toHaveBeenCalledTimes(1);
  });

  it('stops waiting as soon as the signal aborts, mid-request', async () => {
    searchMock.mockImplementation(() => never());
    const controller = new AbortController();

    const pending = runTool(searchTool, { query: 'slow' }, { abortSignal: controller.signal });
    const outcome = expect(pending).rejects.toThrow(/abort/i);
    controller.abort();

    await outcome;
  });

  it('refuses to start once the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runTool(searchTool, { query: 'too late' }, { abortSignal: controller.signal })
    ).rejects.toThrow(/abort/i);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('aborts during the backoff instead of waiting it out', async () => {
    vi.useFakeTimers();
    searchMock.mockRejectedValue(apiError(503, 'Unavailable'));
    const controller = new AbortController();

    const pending = runTool(searchTool, { query: 'flaky' }, { abortSignal: controller.signal });
    const outcome = expect(pending).rejects.toThrow(/abort/i);

    await vi.advanceTimersByTimeAsync(0); // first attempt fails, backoff starts
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await outcome;
    expect(searchMock).toHaveBeenCalledTimes(1);
  });
});

describe('scrapeTool', () => {
  it('returns the recorded markdown and the page title', async () => {
    scrapeMock.mockResolvedValueOnce(scrapeFixture);

    const result = await runTool<{ url: string }, ScrapeOutput>(scrapeTool, {
      url: 'https://firecrawl.dev',
    });

    expect(scrapeMock).toHaveBeenCalledWith('https://firecrawl.dev', {
      formats: ['markdown'],
      timeout: 30_000,
    });
    expect(result.markdown).toBe(scrapeFixture.markdown);
    expect(result.title).toBe(scrapeFixture.metadata.title);
    expect(result.blocked).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('prefixes https:// when the url has no scheme', async () => {
    scrapeMock.mockResolvedValueOnce(scrapeFixture);

    const result = await runTool<{ url: string }, ScrapeOutput>(scrapeTool, { url: 'firecrawl.dev' });

    expect(scrapeMock.mock.calls[0][0]).toBe('https://firecrawl.dev');
    expect(result.url).toBe('https://firecrawl.dev');
  });

  it('refuses a blocked url with a reason instead of fetching it', async () => {
    const writer = recordingWriter();

    const result = await runTool<{ url: string }, ScrapeOutput>(
      scrapeTool,
      { url: 'https://www.linkedin.com/company/acme' },
      { writer: writer as never }
    );

    expect(scrapeMock).not.toHaveBeenCalled();
    expect(result.blocked).toBe(true);
    expect(result.markdown).toBe('');
    expect(result.reason).toContain('blocked domain');
    expect(progressEvents(writer)[0].sourceUrl).toBe('https://www.linkedin.com/company/acme');
  });

  it('trims a page that would otherwise flood the context', async () => {
    scrapeMock.mockResolvedValueOnce({ markdown: 'y'.repeat(100_000), metadata: {} });

    const result = await runTool<{ url: string }, ScrapeOutput>(scrapeTool, {
      url: 'https://acme.example/huge',
    });

    expect(result.markdown).toHaveLength(40_000);
    expect(result.truncated).toBe(true);
  });

  it('retries once with TLS verification relaxed after a certificate failure', async () => {
    scrapeMock
      .mockRejectedValueOnce(new Error('SSL error: unable to verify the first certificate'))
      .mockResolvedValueOnce(scrapeFixture);

    const result = await runTool<{ url: string }, ScrapeOutput>(scrapeTool, {
      url: 'https://self-signed.example',
    });

    expect(scrapeMock).toHaveBeenCalledTimes(2);
    expect(scrapeMock.mock.calls[1][1]).toMatchObject({ skipTlsVerification: true });
    expect(result.markdown).toBe(scrapeFixture.markdown);
  });

  it('retries a transient failure with backoff', async () => {
    vi.useFakeTimers();
    scrapeMock.mockRejectedValueOnce(apiError(502)).mockResolvedValueOnce(scrapeFixture);

    const pending = runTool<{ url: string }, ScrapeOutput>(scrapeTool, {
      url: 'https://flaky.example',
    });
    await vi.runAllTimersAsync();

    expect((await pending).markdown).toBe(scrapeFixture.markdown);
    expect(scrapeMock).toHaveBeenCalledTimes(2);
  });

  it('treats a network error as retryable', async () => {
    vi.useFakeTimers();
    scrapeMock.mockRejectedValueOnce(new Error('network error')).mockResolvedValueOnce(scrapeFixture);

    const pending = runTool<{ url: string }, ScrapeOutput>(scrapeTool, {
      url: 'https://offline.example',
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toHaveProperty('markdown', scrapeFixture.markdown);
  });

  it('throws immediately on a non-retryable error', async () => {
    scrapeMock.mockRejectedValueOnce(apiError(404, 'Not found'));

    await expect(runTool(scrapeTool, { url: 'https://missing.example' })).rejects.toThrow('Not found');
    expect(scrapeMock).toHaveBeenCalledTimes(1);
  });

  it('writes a progress event naming the page it is reading', async () => {
    scrapeMock.mockResolvedValueOnce(scrapeFixture);
    const writer = recordingWriter();

    await runTool(scrapeTool, { url: 'https://firecrawl.dev' }, { writer: writer as never });

    expect(progressEvents(writer)).toEqual([
      {
        type: 'firecrawl-progress',
        message: 'Reading https://firecrawl.dev',
        sourceUrl: 'https://firecrawl.dev',
      },
    ]);
  });

  it('stops waiting as soon as the signal aborts', async () => {
    scrapeMock.mockImplementation(() => never());
    const controller = new AbortController();

    const pending = runTool(
      scrapeTool,
      { url: 'https://slow.example' },
      { abortSignal: controller.signal }
    );
    const outcome = expect(pending).rejects.toThrow(/abort/i);
    controller.abort();

    await outcome;
  });
});

describe('mapTool', () => {
  it('returns the recorded links and forwards the caller’s search term', async () => {
    mapMock.mockResolvedValueOnce(mapFixture);

    const result = await runTool<{ url: string; search?: string }, MapOutput>(mapTool, {
      url: 'https://firecrawl.dev',
      search: 'pricing',
    });

    expect(mapMock).toHaveBeenCalledWith('https://firecrawl.dev', { search: 'pricing', limit: 100 });
    expect(result.links).toHaveLength(mapFixture.links.length);
    expect(result.links[0].url).toBe(mapFixture.links[0].url);
    expect(result.truncated).toBe(false);
  });

  it('caps the list and says it did', async () => {
    mapMock.mockResolvedValueOnce(mapFixture);

    const result = await runTool<{ url: string; limit?: number }, MapOutput>(mapTool, {
      url: 'https://firecrawl.dev',
      limit: 3,
    });

    expect(mapMock).toHaveBeenCalledWith('https://firecrawl.dev', { search: undefined, limit: 3 });
    expect(result.links).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('drops links on blocked domains', async () => {
    mapMock.mockResolvedValueOnce({
      links: [
        { url: 'https://acme.example/pricing' },
        { url: 'https://twitter.com/acme' },
        { url: 'https://acme.example/about' },
      ],
    });

    const result = await runTool<{ url: string }, MapOutput>(mapTool, { url: 'acme.example' });

    expect(result.links.map((link) => link.url)).toEqual([
      'https://acme.example/pricing',
      'https://acme.example/about',
    ]);
    expect(result.blockedCount).toBe(1);
  });

  it('writes a progress event naming the site and the term', async () => {
    mapMock.mockResolvedValueOnce({ links: [] });
    const writer = recordingWriter();

    await runTool(
      mapTool,
      { url: 'https://acme.example', search: 'careers' },
      { writer: writer as never }
    );

    expect(progressEvents(writer)).toEqual([
      {
        type: 'firecrawl-progress',
        message: 'Mapping https://acme.example for "careers"',
        sourceUrl: 'https://acme.example',
      },
    ]);
  });

  it('stops waiting as soon as the signal aborts', async () => {
    mapMock.mockImplementation(() => never());
    const controller = new AbortController();

    const pending = runTool(
      mapTool,
      { url: 'https://slow.example' },
      { abortSignal: controller.signal }
    );
    const outcome = expect(pending).rejects.toThrow(/abort/i);
    controller.abort();

    await outcome;
  });
});
