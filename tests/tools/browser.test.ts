/**
 * The browser agent must be importable without a Firecrawl key.
 *
 * `FirecrawlBrowser` throws at construction when `FIRECRAWL_API_KEY` is unset,
 * and building it at module load took down a keyless `next build` and a
 * keyless `mastra dev` boot. These tests run the real package, not a mock, so
 * they prove the deferral against the SDK's actual throw.
 *
 * The module is imported once, with the key removed, and the tests run in
 * order against that one instance: first use without the key, then first use
 * after it appears. Re-importing per test would reload all of `@mastra/core`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { browserAgent as BrowserAgent } from '@/lib/mastra/agents/browser';

const originalKey = process.env.FIRECRAWL_API_KEY;

let browserAgent: typeof BrowserAgent;
let FirecrawlBrowser: typeof import('@mastra/browser-firecrawl').FirecrawlBrowser;

beforeAll(async () => {
  delete process.env.FIRECRAWL_API_KEY;

  ({ browserAgent } = await import('@/lib/mastra/agents/browser'));
  ({ FirecrawlBrowser } = await import('@mastra/browser-firecrawl'));
}, 120_000);

afterAll(() => {
  process.env.FIRECRAWL_API_KEY = originalKey;
});

describe('browserAgent', () => {
  it('can be imported without FIRECRAWL_API_KEY', () => {
    expect(browserAgent.id).toBe('browser');
    expect(browserAgent.hasOwnBrowser()).toBe(true);
  });

  it('fails on first use, with the SDK’s message, while the key is missing', () => {
    expect(() => browserAgent.browser?.name).toThrow(/FIRECRAWL_API_KEY/);
  });

  it('reads the key when the browser is first used, not when the module loaded', () => {
    process.env.FIRECRAWL_API_KEY = 'stub';

    const browser = browserAgent.browser;

    expect(browser).toBeInstanceOf(FirecrawlBrowser);
    expect(browser?.name).toBe('FirecrawlBrowser');
    expect(browser?.providerType).toBe('sdk');
    expect(typeof browser?.getTools).toBe('function');
  });

  it('builds one browser and keeps it, so the shared session is not re-provisioned', () => {
    // A value written through one read is visible through the next only if
    // both reach the same underlying instance.
    Reflect.set(browserAgent.browser as object, 'probe', 42);
    expect(Reflect.get(browserAgent.browser as object, 'probe')).toBe(42);
  });
});
