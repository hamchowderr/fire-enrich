import type { ParseConfig, ParseError, ParseResult } from 'papaparse';
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
 * PapaParse reports `UndetectableDelimiter` when it cannot guess the
 * delimiter, then parses with the default comma anyway. A file with one
 * column has no delimiter to detect, so the warning is expected there. It is
 * ignored only when the rows it produced hold at least one email address;
 * every other error, and this one on a file with no email, is still fatal.
 */
function isIgnorableDelimiterWarning(error: ParseError, rows: CSVRow[]): boolean {
  if (error.code !== 'UndetectableDelimiter') return false;
  return rows.some((row) =>
    Object.values(row).some(
      (value) => typeof value === 'string' && EMAIL_REGEX.test(value.trim()),
    ),
  );
}

/** Turns a PapaParse result into the rows and columns the uploader hands on. */
export function readCsvParseResult(results: ParseResult<CSVRow>): CsvUploadResult {
  const rows = results.data ?? [];
  const errors = results.errors.filter(
    (error) => !isIgnorableDelimiterWarning(error, rows),
  );

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
