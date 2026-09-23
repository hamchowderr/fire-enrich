import { afterEach, describe, expect, it, vi } from 'vitest';

import { mastra } from '@/lib/mastra';
import {
  enrichRowWithMastra,
  filterCitations,
  translateChunk,
  VisitedUrls,
  type RunRecording,
} from '@/lib/mastra/enrich-adapter';
import type { EnrichmentResult } from '@/lib/types';

const EMAIL = 'hello@acme.example';

const output = (event: Record<string, unknown>) => ({ type: 'workflow-step-output', payload: { output: event } });

describe('translateChunk', () => {
  it('announces identification from the email domain', () => {
    expect(translateChunk({ type: 'workflow-step-start', payload: { id: 'identify' } }, EMAIL, new VisitedUrls())).toEqual([
      { message: 'Identifying company from acme.example', messageType: 'info' },
    ]);
  });

  it('reports who was identified, or warns when nobody was', () => {
    const found = {
      type: 'workflow-step-result',
      payload: { id: 'identify', status: 'success', output: { companyName: 'Acme', website: 'https://acme.example/' } },
    };
    const missing = { type: 'workflow-step-result', payload: { id: 'identify', status: 'success', output: { companyName: '' } } };

    expect(translateChunk(found, EMAIL, new VisitedUrls())).toEqual([
      { message: 'Identified Acme (https://acme.example/)', messageType: 'success', sourceUrl: 'https://acme.example/' },
    ]);
    expect(translateChunk(missing, EMAIL, new VisitedUrls())[0].messageType).toBe('warning');
  });

  it('maps group start and completion', () => {
    const visited = new VisitedUrls();
    const base = { groupId: 'g', label: 'Pricing', fieldNames: ['a', 'b'] };

    expect(translateChunk(output({ type: 'group-start', strategy: 'search', ...base }), EMAIL, visited)).toEqual([
      { message: 'Pricing: searching (a, b)', messageType: 'agent' },
    ]);
    expect(
      translateChunk(output({ type: 'group-complete', found: 2, structuredOutputFailed: false, ...base }), EMAIL, visited)
    ).toEqual([{ message: 'Pricing complete: 2 fields', messageType: 'success' }]);
    expect(
      translateChunk(output({ type: 'group-complete', found: 0, structuredOutputFailed: false, ...base }), EMAIL, visited)[0]
    ).toMatchObject({ messageType: 'warning' });
    expect(
      translateChunk(output({ type: 'group-complete', found: 0, structuredOutputFailed: true, ...base }), EMAIL, visited)[0]
    ).toMatchObject({ messageType: 'warning', message: expect.stringMatching(/unusable/) });
  });

  it('passes progress and evidence through with their url, without counting either as read', () => {
    const visited = new VisitedUrls();

    expect(
      translateChunk(output({ type: 'firecrawl-progress', message: 'Read: Pricing', sourceUrl: 'https://acme.example/pricing', groupId: 'g' }), EMAIL, visited)
    ).toEqual([{ message: 'Read: Pricing', messageType: 'info', sourceUrl: 'https://acme.example/pricing' }]);
    expect(
      translateChunk(output({ type: 'evidence', groupId: 'g', field: 'price', url: 'https://www.news.example/a', quote: 'q' }), EMAIL, visited)
    ).toEqual([{ message: 'price: evidence from news.example', messageType: 'success', sourceUrl: 'https://www.news.example/a' }]);

    expect(visited.has('https://acme.example/pricing')).toBe(false);
    expect(visited.has('https://news.example/a')).toBe(false);
  });

  it('records page-read urls as visited without a progress line', () => {
    const visited = new VisitedUrls();

    expect(translateChunk(output({ type: 'page-read', groupId: 'g', url: 'https://www.acme.example/pricing/' }), EMAIL, visited)).toEqual([]);
    expect(visited.has('https://acme.example/pricing')).toBe(true);
  });

  it('ignores everything else', () => {
    const visited = new VisitedUrls();

    for (const chunk of [
      { type: 'workflow-step-start', payload: { id: 'research-group' } },
      { type: 'text-delta', payload: { text: 'hi' } },
      output({ type: 'something-else' }),
      { type: 'workflow-finish', payload: {} },
      null,
    ]) {
      expect(translateChunk(chunk, EMAIL, visited)).toEqual([]);
    }
  });
});

describe('filterCitations', () => {
  const enrichment = (urls: string[]): EnrichmentResult => ({
    field: 'f',
    value: 'v',
    confidence: 0.8,
    source: urls[0],
    sourceContext: urls.map((url) => ({ url, snippet: `quote from ${url}` })),
    sourceCount: urls.length,
    corroboration: {
      evidence: urls.map((url) => ({ value: 'v', source_url: url, exact_text: 'q', confidence: 0.8 })),
      sources_agree: true,
    },
  });

  it('keeps only citations the stream showed being read', () => {
    const visited = new VisitedUrls();
    visited.add('https://read.example/');

    const kept = filterCitations({ f: enrichment(['https://unread.example/', 'https://read.example/']) }, visited);

    expect(kept.f.source).toBe('https://read.example/');
    expect(kept.f.sourceContext).toEqual([{ url: 'https://read.example/', snippet: 'quote from https://read.example/' }]);
    expect(kept.f.sourceCount).toBe(1);
    expect(kept.f.corroboration?.evidence.map((item) => item.source_url)).toEqual(['https://read.example/']);
  });

  it('drops a field left with no read citation', () => {
    expect(filterCitations({ f: enrichment(['https://unread.example/']) }, new VisitedUrls())).toEqual({});
  });
});

describe('enrichRowWithMastra recording', () => {
  const READ = 'https://read.example/';
  const UNREAD = 'https://unread.example/';

  const cited = (field: string, urls: string[]): EnrichmentResult => ({
    field,
    value: `${field} value`,
    confidence: 0.8,
    source: urls[0],
    sourceContext: urls.map((url) => ({ url, snippet: `quote from ${url}` })),
    sourceCount: urls.length,
  });

  const groupOf = (groupId: string, strategy: 'search' | 'agent' | 'browser', fieldNames: string[]) => ({
    groupId,
    strategy,
    fieldNames,
    found: fieldNames.length,
    structuredOutputFailed: false,
    notes: '',
  });

  /** A workflow whose stream shows only READ being read, then resolves to `result`. */
  function stubWorkflow(result: unknown) {
    const run = {
      cancel: vi.fn(async () => undefined),
      stream: () => ({
        fullStream: (async function* () {
          yield { type: 'workflow-step-output', payload: { output: { type: 'page-read', groupId: 'g', url: READ } } };
        })(),
        result: Promise.resolve(result),
      }),
    };
    vi.spyOn(mastra, 'getWorkflow').mockReturnValue({ createRun: async () => run } as never);
  }

  function enrich(recordRow: ReturnType<typeof vi.fn>) {
    return enrichRowWithMastra({
      sessionId: 's',
      rowIndex: 2,
      row: { email: 'a@acme.example' },
      email: 'a@acme.example',
      plan: {} as never,
      fields: [],
      onProgress: () => {},
      recording: { recordRow } as unknown as RunRecording,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records the citation-filtered enrichments, with each field\'s first group strategy', async () => {
    stubWorkflow({
      status: 'success',
      result: {
        enrichments: { price: cited('price', [UNREAD, READ]), rumour: cited('rumour', [UNREAD]) },
        groups: [groupOf('pricing', 'browser', ['price']), groupOf('news', 'search', ['price', 'rumour'])],
      },
    });
    const recordRow = vi.fn(async () => undefined);

    const result = await enrich(recordRow);

    expect(recordRow).toHaveBeenCalledOnce();
    const [rowIndex, email, enrichments, strategies] = recordRow.mock.calls[0] as unknown as [
      number,
      string,
      Record<string, EnrichmentResult>,
      Record<string, string>,
    ];
    expect([rowIndex, email]).toEqual([2, 'a@acme.example']);
    // The unread citation is gone, and a field left with none is not recorded.
    expect(Object.keys(enrichments)).toEqual(['price']);
    expect(enrichments.price.sourceContext?.map((context) => context.url)).toEqual([READ]);
    expect(strategies).toEqual({ price: 'browser', rumour: 'search' });
    // What is recorded is what the UI is sent.
    expect(result?.enrichments).toEqual(enrichments);
  });

  it('records nothing for a row that failed', async () => {
    stubWorkflow({ status: 'failed', error: new Error('model unavailable') });
    const recordRow = vi.fn(async () => undefined);

    const result = await enrich(recordRow);

    expect(result).toMatchObject({ status: 'error', error: 'model unavailable' });
    expect(recordRow).not.toHaveBeenCalled();
  });
});
