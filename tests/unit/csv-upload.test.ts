/**
 * The uploader's CSV handling (`lib/utils/csv-upload.ts`): the file is parsed
 * with PapaParse and the same options the uploader uses, then read with
 * `readCsvParseResult`. A string input parses synchronously.
 */
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';

import type { CSVRow } from '@/lib/types';
import { CSV_PARSE_CONFIG, readCsvParseResult } from '@/lib/utils/csv-upload';
import { detectEmailColumn } from '@/lib/utils/email-detection';

function parse(text: string) {
  const results = Papa.parse<CSVRow>(text, CSV_PARSE_CONFIG);
  return { results, parsed: readCsvParseResult(results) };
}

describe('readCsvParseResult', () => {
  it('accepts a one-column CSV of emails although PapaParse cannot detect a delimiter', () => {
    const { results, parsed } = parse('email\nhello@firecrawl.dev\n');

    // The warning that used to reject the file is still reported by PapaParse.
    expect(results.errors.map((error) => error.code)).toEqual(['UndetectableDelimiter']);
    expect(parsed).toEqual({
      rows: [{ email: 'hello@firecrawl.dev' }],
      columns: ['email'],
    });
  });

  it('accepts a one-column CSV with several rows and CRLF line endings', () => {
    const { parsed } = parse('Email\r\na@example.com\r\nb@example.com\r\n');

    expect(parsed).toEqual({
      rows: [{ Email: 'a@example.com' }, { Email: 'b@example.com' }],
      columns: ['Email'],
    });
  });

  it('hands a one-column upload to email-column detection', () => {
    const { parsed } = parse('contact\nhello@firecrawl.dev\n');
    if ('error' in parsed) throw new Error(parsed.error);

    expect(detectEmailColumn(parsed.rows, parsed.columns)).toMatchObject({
      columnName: 'contact',
      columnIndex: 0,
    });
  });

  it('still rejects an undetectable delimiter when no row holds an email', () => {
    const { parsed } = parse('company\nFirecrawl\n');

    expect(parsed).toEqual({
      error: "CSV parsing error: Unable to auto-detect delimiting character; defaulted to ','",
    });
  });

  it('rejects a colon-delimited file, whose cells hold more than an address', () => {
    const { results, parsed } = parse('name:email\nFirecrawl:hello@firecrawl.dev\n');

    // PapaParse does not try `:`, so the whole line lands in one column.
    expect(results.meta.fields).toEqual(['name:email']);
    expect(parsed).toEqual({
      error: "CSV parsing error: Unable to auto-detect delimiting character; defaulted to ','",
    });
  });

  it('rejects a space-delimited file', () => {
    const { results, parsed } = parse('name email\nFirecrawl hello@firecrawl.dev\n');

    expect(results.meta.fields).toEqual(['name email']);
    expect(parsed).toEqual({
      error: "CSV parsing error: Unable to auto-detect delimiting character; defaulted to ','",
    });
  });

  it('reports a one-column header with no rows as empty', () => {
    expect(parse('email\n').parsed).toEqual({ error: 'CSV file is empty' });
  });

  it('rejects a CSV with an unclosed quote', () => {
    const { results, parsed } = parse('name,email\n"Firecrawl,hello@firecrawl.dev\n');

    expect(results.errors.map((error) => error.code)).toContain('MissingQuotes');
    expect(parsed).toHaveProperty('error');
    if ('error' in parsed) expect(parsed.error).toMatch(/^CSV parsing error: .*quote/i);
  });

  it('rejects a one-column CSV that also has a malformed row', () => {
    const { parsed } = parse('email\nhello@firecrawl.dev\n"broken@firecrawl.dev\n');

    expect(parsed).toHaveProperty('error');
    if ('error' in parsed) expect(parsed.error).toMatch(/^CSV parsing error: .*quote/i);
  });

  it('rejects a row with more fields than the header', () => {
    const { results, parsed } = parse('name,email\nFirecrawl,hello@firecrawl.dev,extra\n');

    expect(results.errors.map((error) => error.code)).toContain('TooManyFields');
    expect(parsed).toHaveProperty('error');
  });

  it('parses a multi-column CSV as before', () => {
    const { results, parsed } = parse(
      ' name , email ,website\nFirecrawl , hello@firecrawl.dev,firecrawl.dev\n,,\nMendable,team@mendable.ai,mendable.ai\n',
    );

    expect(results.errors).toEqual([]);
    expect(parsed).toEqual({
      rows: [
        { name: 'Firecrawl', email: 'hello@firecrawl.dev', website: 'firecrawl.dev' },
        { name: 'Mendable', email: 'team@mendable.ai', website: 'mendable.ai' },
      ],
      columns: ['name', 'email', 'website'],
    });
  });

  it('rejects an empty file', () => {
    expect(parse('').parsed).toEqual({ error: 'CSV file is empty' });
  });
});
