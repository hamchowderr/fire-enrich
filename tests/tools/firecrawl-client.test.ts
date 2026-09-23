/**
 * `firecrawlClient()`: the options it builds the SDK client with.
 *
 * `FIRECRAWL_API_URL` points the tools at another Firecrawl origin (a
 * self-hosted instance, or the stub the browser tests run against); unset, the
 * SDK keeps its own default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { constructed } = vi.hoisted(() => ({ constructed: [] as unknown[] }));

vi.mock('firecrawl', () => ({
  Firecrawl: class {
    constructor(options: unknown) {
      constructed.push(options);
    }
  },
}));

import { firecrawlClient } from '@/lib/mastra/tools/firecrawl-client';

describe('firecrawlClient', () => {
  const original = process.env.FIRECRAWL_API_URL;

  afterEach(() => {
    constructed.length = 0;
    if (original === undefined) delete process.env.FIRECRAWL_API_URL;
    else process.env.FIRECRAWL_API_URL = original;
  });

  it('passes no apiUrl when FIRECRAWL_API_URL is unset, so the SDK default applies', () => {
    delete process.env.FIRECRAWL_API_URL;
    firecrawlClient();
    expect(constructed).toEqual([{ apiKey: 'stub' }]);
  });

  it('passes FIRECRAWL_API_URL as apiUrl when it is set', () => {
    process.env.FIRECRAWL_API_URL = 'http://127.0.0.1:4131';
    firecrawlClient();
    expect(constructed).toEqual([{ apiKey: 'stub', apiUrl: 'http://127.0.0.1:4131' }]);
  });

  it('treats an empty FIRECRAWL_API_URL as unset', () => {
    process.env.FIRECRAWL_API_URL = '  ';
    firecrawlClient();
    expect(constructed).toEqual([{ apiKey: 'stub' }]);
  });
});
