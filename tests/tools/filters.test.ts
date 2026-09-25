import { describe, expect, it } from 'vitest';

import { BLOCKED_DOMAINS_LABEL, isBlockedUrl, splitBlocked } from '@/lib/mastra/tools/filters';

describe('isBlockedUrl', () => {
  it('blocks every domain the orchestrator blocked, plus x.com', () => {
    for (const url of [
      'https://linkedin.com/company/acme',
      'https://facebook.com/acme',
      'https://twitter.com/acme',
      'https://x.com/acme',
      'https://instagram.com/acme',
    ]) {
      expect(isBlockedUrl(url), url).toBe(true);
    }
  });

  it('blocks www and other subdomains of a blocked domain', () => {
    expect(isBlockedUrl('https://www.linkedin.com/in/someone')).toBe(true);
    expect(isBlockedUrl('https://uk.linkedin.com/in/someone')).toBe(true);
    expect(isBlockedUrl('https://business.facebook.com/acme')).toBe(true);
  });

  it('matches the registrable domain, not a substring of the host', () => {
    // The orchestrator's `hostname.includes('x.com')` blocked both of these.
    expect(isBlockedUrl('https://dropbox.com/s/report')).toBe(false);
    expect(isBlockedUrl('https://linkedin.com.phish.example/login')).toBe(false);
  });

  it('treats an unparseable or missing url as not blocked', () => {
    expect(isBlockedUrl('not a url')).toBe(false);
    expect(isBlockedUrl('')).toBe(false);
    expect(isBlockedUrl(undefined)).toBe(false);
  });

  it('names every blocked domain in the label tools show the model', () => {
    for (const domain of ['linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com']) {
      expect(BLOCKED_DOMAINS_LABEL).toContain(domain);
    }
  });
});

describe('splitBlocked', () => {
  it('separates the two halves and preserves order within each', () => {
    const items = [
      { url: 'https://acme.example/about' },
      { url: 'https://linkedin.com/company/acme' },
      { url: 'https://acme.example/pricing' },
      { url: 'https://x.com/acme' },
    ];

    const { allowed, blocked } = splitBlocked(items, (item) => item.url);

    expect(allowed.map((item) => item.url)).toEqual([
      'https://acme.example/about',
      'https://acme.example/pricing',
    ]);
    expect(blocked.map((item) => item.url)).toEqual([
      'https://linkedin.com/company/acme',
      'https://x.com/acme',
    ]);
  });

  it('keeps items whose url accessor returns nothing', () => {
    const { allowed, blocked } = splitBlocked([{}, {}], () => undefined);

    expect(allowed).toHaveLength(2);
    expect(blocked).toHaveLength(0);
  });
});
