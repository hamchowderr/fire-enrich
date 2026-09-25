/**
 * The libSQL connection for the app's own tables: business profiles and saved
 * research plans.
 *
 * Profiles and plans are ordinary app data, so they live in the libSQL
 * database every deployment already has (Turso, or the local file fallback),
 * not in Dolt: Dolt is optional and holds only the versioned run history.
 * It is the same database Mastra's store uses (`lib/libsql-url.mjs`), in
 * tables of its own, so there is nothing extra to provision or configure.
 *
 * The client is separate from Mastra's, on the same url: importing the Mastra
 * instance here would pull every agent into the profile routes, and the
 * planner agent imports this module's callers.
 *
 * Schema: the Vercel build applies `lib/app-db-schema.mjs` to Turso
 * (`scripts/libsql-migrate.mjs`). For a local file (a fresh clone, the tests)
 * the same idempotent statements are applied here on first use, once per
 * process, so a local run needs no migration step.
 */
import { type Client, createClient, type InValue, type Transaction } from '@libsql/client';

import { applyAppDbSchema } from '@/lib/app-db-schema.mjs';
import { isLocalFileUrl, libsqlConnection } from '@/lib/libsql-url.mjs';

type Handle = { client: Client; ready: Promise<Client> };

/**
 * On `globalThis` for the same reason as the Mastra instance: Turbopack
 * re-evaluates route modules on edit, and each evaluation would otherwise open
 * another client on the same database.
 */
const globalForDb = globalThis as typeof globalThis & { __fireEnrichAppDb?: Handle };

function open(): Handle {
  const { url, authToken } = libsqlConnection();
  const client = createClient({ url, authToken });
  const ready = isLocalFileUrl(url)
    ? applyAppDbSchema(client).then(() => client)
    : Promise.resolve(client);

  // A failed schema step is not cached: the next call opens a fresh handle
  // and tries again rather than failing every request until a restart.
  ready.catch(() => {
    if (globalForDb.__fireEnrichAppDb?.client === client) {
      globalForDb.__fireEnrichAppDb = undefined;
      client.close();
    }
  });

  return { client, ready };
}

/**
 * The client, with the schema applied when the database is a local file.
 * Opened lazily: importing this module must not open a database, because Next
 * imports route modules at build time.
 */
export function appDb(): Promise<Client> {
  globalForDb.__fireEnrichAppDb ??= open();
  return globalForDb.__fireEnrichAppDb.ready;
}

/**
 * Close the client and forget it, so the next {@link appDb} opens a new one
 * against whatever `TURSO_DATABASE_URL` says then. For tests, which point each
 * file at its own temporary database.
 *
 * @public Used by the tests only.
 */
export function resetAppDb(): void {
  globalForDb.__fireEnrichAppDb?.client.close();
  globalForDb.__fireEnrichAppDb = undefined;
}

/**
 * Run `work` in a write transaction (`BEGIN IMMEDIATE`) on a client of its
 * own, opened for this call and closed after it.
 *
 * A dedicated client rather than the shared one because of how a failed
 * `BEGIN` leaves a connection in `@libsql/client` 0.18: when `BEGIN IMMEDIATE`
 * fails with SQLITE_BUSY, the connection goes back to the client's pool with
 * that statement still in progress, and every later transaction on it fails
 * to commit ("cannot commit transaction - SQL statements in progress"). A
 * caller that retries on SQLITE_BUSY would otherwise poison the shared client
 * for every request. Closing the dedicated client discards the connection.
 *
 * `close()` on the transaction rolls it back unless `work` committed it.
 */
export async function withWriteTransaction<T>(work: (transaction: Transaction) => Promise<T>): Promise<T> {
  await appDb(); // the schema, for a local file
  const client = createClient(libsqlConnection());

  try {
    const transaction = await client.transaction('write');
    try {
      return await work(transaction);
    } finally {
      transaction.close();
    }
  } finally {
    client.close();
  }
}

/** A row as libSQL returns it, keyed by column name. */
export type Row = Record<string, unknown>;

/** Run a SELECT and return its rows as plain objects. Parameters are always bound. */
export async function selectRows(sql: string, args: InValue[] = []): Promise<Row[]> {
  const result = await (await appDb()).execute({ sql, args });
  return result.rows.map((row) => ({ ...row }));
}

/**
 * Parse the named JSON columns of one row.
 *
 * Tolerant on purpose: a string that does not parse is left as it is rather
 * than throwing, so one malformed row cannot take down a list endpoint. The
 * `json_valid` checks in the schema keep such a row from being written.
 */
export function parseJsonColumns<T extends Row>(row: T, jsonColumns: readonly string[]): T {
  const parsed: Row = { ...row };

  for (const column of jsonColumns) {
    const value = parsed[column];
    if (typeof value !== 'string') continue;
    try {
      parsed[column] = JSON.parse(value);
    } catch {
      // Leave the raw string; a caller's schema reports it better.
    }
  }

  return parsed as T;
}

/** Serialise a value for a JSON column. `null` and `undefined` become SQL NULL. */
export function toJsonColumn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

/** The error codes libSQL reports, from `LibsqlError`: `code` and `extendedCode`. */
function codes(error: unknown): string[] {
  const { code, extendedCode } = (error ?? {}) as { code?: unknown; extendedCode?: unknown };
  return [code, extendedCode].filter((value): value is string => typeof value === 'string');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A write collided with a UNIQUE index. libSQL reports `SQLITE_CONSTRAINT`
 * with the extended code `SQLITE_CONSTRAINT_UNIQUE` from a local file; over
 * the network the extended code can be missing, so the message SQLite writes
 * ("UNIQUE constraint failed: <table>.<column>") is checked too.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    codes(error).includes('SQLITE_CONSTRAINT_UNIQUE') ||
    /UNIQUE constraint failed/i.test(message(error))
  );
}

/**
 * Another connection holds the database's write lock: SQLite allows one write
 * transaction at a time, and `BEGIN IMMEDIATE` (or a write in a transaction
 * that started reading) fails with `SQLITE_BUSY` rather than waiting. Nothing
 * of the failed transaction was written, so it is safe to start again.
 */
export function isBusy(error: unknown): boolean {
  return (
    codes(error).some((code) => code.startsWith('SQLITE_BUSY')) ||
    /database is locked|SQLITE_BUSY/i.test(message(error))
  );
}
