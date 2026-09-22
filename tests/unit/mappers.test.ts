import { describe, expect, it } from 'vitest';

import { checkFindings, toEnrichments, type GroupResult } from '@/lib/mastra/mappers';
import type { EnrichFieldDefinitionType, FindingType } from '@/lib/mastra/schemas';

const quote = (url: string, text = 'quoted text', confidence = 0.8) => ({ url, quote: text, confidence });

const finding = (field: string, value: FindingType['value'], evidence = [quote('https://acme.example/')]): FindingType => ({
  field,
  value,
  confidence: 0.7,
  evidence,
  sourcesAgree: true,
});

const group = (fieldNames: string[], findings: FindingType[], extra: Partial<GroupResult> = {}): GroupResult => ({
  groupId: 'g1',
  strategy: 'search',
  fieldNames,
  findings,
  notes: '',
  structuredOutputFailed: false,
  ...extra,
});

const field = (name: string, type: EnrichFieldDefinitionType['type'] = 'string'): EnrichFieldDefinitionType => ({
  name,
  displayName: name,
  description: name,
  type,
});

describe('checkFindings', () => {
  it('matches urls ignoring www, a trailing slash, the hash and host case, but not the query', () => {
    const cited = [quote('https://WWW.Acme.example/about/#team'), quote('https://acme.example/p?id=2')];
    const { findings } = checkFindings([finding('a', 'x', cited)], ['a'], [
      'https://acme.example/about',
      'https://acme.example/p?id=1',
    ]);

    expect(findings[0].evidence.map((item) => item.url)).toEqual(['https://WWW.Acme.example/about/#team']);
  });

  it('keeps evidence from pages the tools read, whatever the url spelling', () => {
    const { findings, notes } = checkFindings([finding('a', 'x')], ['a'], ['https://www.acme.example']);

    expect(findings[0].evidence).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it('drops evidence from unread pages and nulls a value left with none', () => {
    const { findings, notes } = checkFindings(
      [finding('a', 'x', [quote('https://invented.example/')])],
      ['a'],
      ['https://acme.example/']
    );

    expect(findings).toEqual([{ ...finding('a', null, []), confidence: 0 }]);
    expect(notes.join(' ')).toMatch(/no tool read/);
  });

  it('drops findings for fields outside the group and keeps the first of duplicates', () => {
    const { findings } = checkFindings(
      [finding('a', 'first'), finding('a', 'second'), finding('b', 'other')],
      ['a'],
      ['https://acme.example/']
    );

    expect(findings.map((item) => [item.field, item.value])).toEqual([['a', 'first']]);
  });

  it('passes an honest null through', () => {
    const { findings } = checkFindings([finding('a', null, [])], ['a'], []);

    expect(findings[0].value).toBeNull();
  });
});

describe('toEnrichments', () => {
  it('maps a finding to the EnrichmentResult shape', () => {
    const evidence = [quote('https://acme.example/', 'Acme makes anvils', 0.9), quote('https://news.example/acme', 'anvils', 1.4)];
    const { enrichments, unknown } = toEnrichments([field('product')], [group(['product'], [finding('product', 'Anvils', evidence)])]);

    expect(unknown).toEqual([]);
    expect(enrichments.product).toEqual({
      field: 'product',
      value: 'Anvils',
      confidence: 0.7,
      source: 'https://acme.example/',
      sourceContext: [
        { url: 'https://acme.example/', snippet: 'Acme makes anvils' },
        { url: 'https://news.example/acme', snippet: 'anvils' },
      ],
      sourceCount: 2,
      corroboration: {
        evidence: [
          { value: 'Anvils', source_url: 'https://acme.example/', exact_text: 'Acme makes anvils', confidence: 0.9 },
          { value: 'Anvils', source_url: 'https://news.example/acme', exact_text: 'anvils', confidence: 1 },
        ],
        sources_agree: true,
      },
    });
  });

  it('coerces values to the field type only when lossless', () => {
    const fields = [field('count', 'number'), field('fuzzy', 'number'), field('flag', 'boolean'), field('list', 'array'), field('text')];
    const findings = [
      finding('count', '1,200'),
      finding('fuzzy', 'about fifty'),
      finding('flag', 'Yes'),
      finding('list', 'email'),
      finding('text', ['a', 'b']),
    ];
    const { enrichments } = toEnrichments(fields, [group(fields.map((item) => item.name), findings)]);

    expect(enrichments.count.value).toBe(1200);
    expect(enrichments.fuzzy.value).toBe('about fifty');
    expect(enrichments.flag.value).toBe(true);
    expect(enrichments.list.value).toEqual(['email']);
    expect(enrichments.text.value).toBe('a, b');
  });

  it('leaves fields unknown, with the reason, and never fills them', () => {
    const fields = [field('nullish'), field('missing'), field('failed'), field('unplanned')];
    const { enrichments, unknown } = toEnrichments(fields, [
      group(['nullish', 'missing'], [finding('nullish', null, [])], { notes: 'Searched the site.' }),
      group(['failed'], [], { groupId: 'g2', structuredOutputFailed: true }),
    ]);

    expect(enrichments).toEqual({});
    expect(unknown).toEqual([
      { field: 'nullish', reason: 'No evidence found by research group "g1". Searched the site.' },
      { field: 'missing', reason: 'Research group "g1" returned no finding for this field. Searched the site.' },
      { field: 'failed', reason: 'Research group "g2" did not return a valid result.' },
      { field: 'unplanned', reason: 'No research group in the plan covers this field.' },
    ]);
  });
});
