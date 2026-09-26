import type { ParseConfig, ParseError, ParseResult } from 'papaparse';
import { z } from 'zod';
import { CSVRow } from '@/lib/types';
import { EMAIL_REGEX } from '@/lib/utils/email-detection';

/** The options the uploader passes to `Papa.parse`, without the callbacks. */
export const CSV_PARSE_CONFIG = {
  header: true,
  skipEmptyLines: true,
  transformHeader: (header: string) => header.trim(),
  transform: (value: string) => value.trim(),
} satisfies ParseConfig<CSVRow>;

export type CsvUploadResult =
  | { rows: CSVRow[]; columns: string[] }
  | { error: string };

/**
 * `EMAIL_REGEX` is anchored, but its `[^\s@]` classes accept characters such
 * as `:`, so `Firecrawl:hello@firecrawl.dev` matches it. Zod's email check
 * rejects those characters, so a cell passes only when it is one address.
 */
const singleAddress = z.string().email();

function isSingleAddress(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const cell = value.trim();
  return EMAIL_REGEX.test(cell) && singleAddress.safeParse(cell).success;
}

const isDelimiterWarning = (error: ParseError) => error.code === 'UndetectableDelimiter';

/**
 * PapaParse reports `UndetectableDelimiter` when it cannot guess the
 * delimiter, then parses with the default comma anyway. A file with one
 * column has no delimiter to detect, so the warning is expected there. It is
 * ignored only when the file parsed to one column and a cell in it is exactly
 * one email address. A file split by a delimiter PapaParse does not try, such
 * as `:` or a space, leaves the delimiter inside its cells, so it still fails.
 * Every other error is still fatal.
 */
function isOneColumnOfEmails(results: ParseResult<CSVRow>): boolean {
  const fields = results.meta.fields ?? [];
  if (fields.length !== 1) return false;
  return results.data.some((row) => isSingleAddress(row[fields[0]]));
}

/** Turns a PapaParse result into the rows and columns the uploader hands on. */
export function readCsvParseResult(results: ParseResult<CSVRow>): CsvUploadResult {
  const rows = results.data ?? [];

  // A header with no rows (`email\n`) has nothing to detect a delimiter from.
  if (rows.length === 0 && results.errors.every(isDelimiterWarning)) {
    return { error: 'CSV file is empty' };
  }

  const errors = isOneColumnOfEmails(results)
    ? results.errors.filter((error) => !isDelimiterWarning(error))
    : results.errors;

  if (errors.length > 0) {
    return { error: `CSV parsing error: ${errors[0].message}` };
  }

  if (rows.length === 0) {
    return { error: 'CSV file is empty' };
  }

  const columns = Object.keys(rows[0]);
  const validRows = rows.filter((row) =>
    Object.values(row).some((value) => value && String(value).trim() !== ''),
  );

  if (validRows.length === 0) {
    return { error: 'No valid data rows found in CSV' };
  }

  return { rows: validRows, columns };
}
