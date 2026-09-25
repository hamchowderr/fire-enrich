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
 * ## One client per call
 *
 * Every statement, read or write, runs on a client opened for that call and
 * closed in a `finally` when the call ends. No client is shared between calls.
 *
 * The reason is a defect in the local-file driver of `@libsql/client` 0.18
 * (https://github.com/tursodatabase/libsql-client-ts/issues/352, open): a
 * statement that fails with SQLITE_BUSY, whether a plain write or a `BEGIN
 * IMMEDIATE`, goes back to the client's connection pool still in progress.
 * Every later transaction or write batch on that connection then fails with
 * "cannot commit transaction - SQL statements in progress" and keeps the
 * database's write lock, so writes from every other client, Mastra's store
 * included, fail until the process restarts. A per-call client is not used
 * again after its call, so a connection left in that state is never reused.
 *
 * `close()` is called in a `finally`, but for a local file it does not free
 * the native database handle: the handle stays open until the garbage
 * collector reclaims the client
 * (https://github.com/tursodatabase/libsql-client-ts/issues/350). So each
 * per-call client on a local file holds a handle until GC releases it. A
 * `libsql:` url uses HTTP and holds no native handle.
 *
 * The cost is small in both modes: a local file opens in well under a
 * millisecond, and a `libsql:` url is served over HTTP, where a client holds
 * no socket of its own.
 *
 * ## Schema
 *
 * The Vercel build applies `lib/app-db-schema.mjs` (`scripts/libsql-migrate.mjs`).
 * Off Vercel (`next dev`, `next start`, the tests) the same idempotent
 * statements run here once per process and database, before the first call,
 * so a local run needs no migration step, with the local file or with a Turso
 * url from `.env.local`. On Vercel only the build migrates, so a Preview
 * deployment never changes a database's schema at runtime.
 */
import {
  type Client,
  createClient,
  type InStatement,
  type InValue,
  type ResultSet,
  type Transaction,
} from '@libsql/client';

import { applyAppDbSchema } from '@/lib/app-db-schema.mjs';
import { libsqlConnection } from '@/lib/libsql-url.mjs';

/**
 * The databases whose schema this process has applied, by url. On
 * `globalThis` so a Turbopack re-evaluation of this module does not apply it
 * again.
 */
const globalForDb = globalThis as typeof globalThis & {
  __fireEnrichAppDbSchema?: Map<string, Promise<void>>;
};

function applied(): Map<string, Promise<void>> {
  return (globalForDb.__fireEnrichAppDbSchema ??= new Map());
}

/** Apply the schema to `url` once per process, off Vercel. A failure is not remembered. */
function ensureSchema(url: string, authToken: string | undefined): Promise<void> {
  if (process.env.VERCEL) return Promise.resolve();

  let pending = applied().get(url);
  if (!pending) {
    pending = (async () => {
      const client = createClient({ url, authToken });
      try {
        await applyAppDbSchema(client);
      } finally {
        client.close();
      }
    })();
    pending.catch(() => applied().delete(url));
    applied().set(url, pending);
  }
  return pending;
}

/**
 * A table this module owns is missing: the database was never migrated.
 * Rethrown with the command that fixes it, so the logged 500 names it.
 */
function withMigrationHint(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!/no such table: (profiles|research_plans)/i.test(message)) return error;
  return new Error(
    `${message}. The profile and plan tables are missing from this libSQL database: ` +
      "run `npm run db:migrate:libsql` with this deployment's TURSO_* variables.",
    { cause: error }
  );
}

/**
 * Run `work` on a client opened for this call and closed when it ends. See
 * the module comment for why no client is shared.
 */
async function withClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const { url, authToken } = libsqlConnection();
  await ensureSchema(url, authToken);

  const client = createClient({ url, authToken });
  try {
    return await work(client);
  } catch (error) {
    throw withMigrationHint(error);
  } finally {
    client.close();
  }
}

/**
 * Forget which databases have had their schema applied, so the next call
 * applies it to whatever `TURSO_DATABASE_URL` names then. For tests, which
 * point each case at its own temporary file.
 *
 * @public Used by the tests only.
 */
export function resetAppDb(): void {
  applied().clear();
}

/** Run one statement. */
export function execute(statement: InStatement): Promise<ResultSet> {
  return withClient((client) => client.execute(statement));
}

/** Run statements as one write batch: one transaction, all or nothing. */
export function batchWrite(statements: InStatement[]): Promise<ResultSet[]> {
  return withClient((client) => client.batch(statements, 'write'));
}

/**
 * Run `work` in a write transaction (`BEGIN IMMEDIATE`) on a client of its
 * own. `close()` on the transaction rolls it back unless `work` committed it.
 */
export function withWriteTransaction<T>(
  work: (transaction: Transaction) => Promise<T>
): Promise<T> {
  return withClient(async (client) => {
    const transaction = await client.transaction('write');
    try {
      return await work(transaction);
    } finally {
      transaction.close();
    }
  });
}

/** A row as libSQL returns it, keyed by column name. */
export type Row = Record<string, unknown>;

/** Run a SELECT and return its rows as plain objects. Parameters are always bound. */
export async function selectRows(sql: string, args: InValue[] = []): Promise<Row[]> {
  const result = await execute({ sql, args });
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
