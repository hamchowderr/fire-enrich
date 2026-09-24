import { describe, expect, it } from 'vitest';

import { readUrlsFromToolResult } from '@/lib/mastra/read-urls';

describe('readUrlsFromToolResult', () => {
  it('reads every search result page', () => {
    const result = {
      query: 'q',
      results: [{ url: 'https://a.example/' }, { url: 'https://b.example/x' }],
      blockedCount: 0,
      truncated: false,
    };

    expect(readUrlsFromToolResult({ toolName: 'search', result })).toEqual(['https://a.example/', 'https://b.example/x']);
  });

  it('reads a scraped page, but not a blocked one', () => {
    expect(readUrlsFromToolResult({ toolName: 'scrape', result: { url: 'https://a.example/p', blocked: false, markdown: '' } })).toEqual([
      'https://a.example/p',
    ]);
    expect(readUrlsFromToolResult({ toolName: 'scrape', result: { url: 'https://a.example/p', blocked: true, markdown: '' } })).toEqual([]);
  });

  it('reads the sources of a completed hosted-agent run only', () => {
    const sources = ['https://a.example/', 'https://b.example/'];

    expect(readUrlsFromToolResult({ toolName: 'firecrawlAgent', result: { status: 'completed', data: {}, sources } })).toEqual(sources);
    expect(readUrlsFromToolResult({ toolName: 'firecrawlAgent', result: { status: 'failed', data: null, sources } })).toEqual([]);
  });

  it('reads nothing from a map, an error, or a blocked domain', () => {
    expect(readUrlsFromToolResult({ toolName: 'map', result: { url: 'https://a.example', links: [{ url: 'https://a.example/x' }] } })).toEqual([]);
    expect(readUrlsFromToolResult({ toolName: 'scrape', isError: true, result: { url: 'https://a.example/p', blocked: false } })).toEqual([]);
    expect(readUrlsFromToolResult({ toolName: 'search', result: { results: [{ url: 'https://www.linkedin.com/company/a' }] } })).toEqual([]);
  });

  it('walks an agent-* sub-agent result in the 1.70 shape', () => {
    // As `Agent.listAgentTools` returns it: the sub-agent's text plus its own
    // tool results, each `{ toolName, toolCallId, args, result, isError }`.
    const result = {
      text: 'The pricing page https://a.example/pricing shows Hobby at $19/month.',
      finishReason: 'stop',
      subAgentToolResults: [
        { toolName: 'scrape', toolCallId: 't1', args: { url: 'https://a.example/pricing' }, result: { url: 'https://a.example/pricing', blocked: false, markdown: '' }, isError: false },
        { toolName: 'scrape', toolCallId: 't2', args: { url: 'https://a.example/404' }, result: undefined, isError: true },
        { toolName: 'browser_navigate', toolCallId: 't3', args: { url: 'https://a.example/tabs' }, result: { url: 'https://a.example/tabs' }, isError: false },
        { toolName: 'map', toolCallId: 't4', args: { url: 'https://a.example' }, result: { url: 'https://a.example', links: [] }, isError: false },
      ],
    };

    expect(readUrlsFromToolResult({ toolName: 'agent-browser', result }).sort()).toEqual([
      'https://a.example/pricing',
      'https://a.example/tabs',
    ]);
  });
});
