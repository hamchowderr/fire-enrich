/**
 * Dolt connection for the app.
 *
 * Dolt speaks the MySQL wire protocol, so this is an ordinary `mysql2` pool.
 * What Dolt adds is {@link commit}: every write ends in a versioned commit, so
 * `dolt_log` answers "who changed this profile and when" and a bad write can be
 * rolled back rather than reconstructed. Data gets the same audit trail code
 * already gets from git.
 *
 * Configuration comes from the environment, never from a checked-in file:
 *
 * - `DOLT_HOST`, `DOLT_PORT`, `DOLT_USER`, `DOLT_PASSWORD`, `DOLT_DATABASE`
 * - `DOLT_TLS_CA_B64` — base64 of the server's CA certificate. A Dolt
 *   server that requires TLS with a self-signed certificate is rejected by
 *   Node unless it is told to trust that CA; a server without TLS, such as a
 *   local dev server, leaves this unset. It is
 *   base64 because a PEM is multi-line and environment variables are not.
 *
 * Dolt is optional: the app boots, enriches and chats with none of these set.
 * Callers check {@link isDoltConfigured} first — the enrichment route skips run
 * recording, the run-history routes answer "requires Dolt" (501) — rather than
 * letting a connection attempt fail deep inside a request.
 */
import mysql from 'mysql2/promise';

import { isDoltConfigured } from './dolt-config.mjs';

/** Environment-variable names this module reads, in one place. */
const ENV = {
  host: 'DOLT_HOST',
  port: 'DOLT_PORT',
  user: 'DOLT_USER',
  password: 'DOLT_PASSWORD',
  database: 'DOLT_DATABASE',
  tlsCa: 'DOLT_TLS_CA_B64',
} as const;

/**
 * Whether Dolt is configured: `DOLT_HOST` and `DOLT_DATABASE` are both set.
 * The one check the whole app uses; see `lib/dolt-config.mjs` for why those two.
 */
export { isDoltConfigured };

/** Connection settings assembled from the environment at first use. */
function config(): mysql.PoolOptions {
  const ca = process.env[ENV.tlsCa];

  return {
    host: process.env[ENV.host] ?? '127.0.0.1',
    port: Number(process.env[ENV.port] ?? 3306),
    user: process.env[ENV.user] ?? 'root',
    password: process.env[ENV.password] ?? '',
    database: process.env[ENV.database],
    // Dates come back as 'YYYY-MM-DD HH:MM:SS' strings rather than Date objects
    // built in the server's local timezone, so a row serialises to JSON the same
    // way on every machine.
    dateStrings: true,
    connectionLimit: 4,
    // Trust exactly the CA that signed the server's certificate. Passing the CA
    // keeps verification on, unlike `rejectUnauthorized: false`, which would
    // accept any certificate and defeat the point of TLS.
    ...(ca ? { ssl: { ca: Buffer.from(ca, 'base64') } } : {}),
  };
}

let cachedPool: mysql.Pool | null = null;

/**
 * The connection pool, created on first use.
 *
 * Lazy because importing this module must not open a socket: Next imports route
 * modules at build time and tests import it with no server running.
 *
 * Not exported: callers go through {@link query} and {@link select} so that
 * parameter binding and JSON handling are not optional.
 */
function pool(): mysql.Pool {
  if (!cachedPool) {
    if (!isDoltConfigured()) {
      throw new Error(
        `Dolt is not configured: set ${ENV.host} and ${ENV.database} (see .env.example).`
      );
    }
    cachedPool = mysql.createPool(config());
  }

  return cachedPool;
}

/**
 * Run any SQL. Returns rows for a SELECT, the result header for a write.
 *
 * Parameters are always bound, never interpolated: `?` placeholders are the only
 * way user input reaches a query in this codebase.
 */
export async function query<T = unknown>(sql: string, params: unknown[] = []): Promise<T> {
  const [result] = await pool().query(sql, params);
  return result as T;
}

/**
 * Run a SELECT and return its rows with JSON columns already parsed.
 *
 * The parsing is here rather than in each caller because it is a property of the
 * transport, not of any one table: `mysql2` hands back a JSON column as a string
 * on some server and driver combinations and as a parsed value on others, so
 * every caller would otherwise need the same defensive branch. See
 * {@link parseJsonColumns}.
 */
export async function select<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
  jsonColumns: readonly string[] = []
): Promise<T[]> {
  const rows = await query<Record<string, unknown>[]>(sql, params);
  return (Array.isArray(rows) ? rows : []).map(
    (row) => parseJsonColumns(row, jsonColumns) as T
  );
}

/**
 * Parse the named JSON columns of one row.
 *
 * Tolerant on purpose: a column that already arrived parsed is passed through,
 * and a string that does not parse is left as-is rather than throwing, so one
 * malformed legacy row cannot take down a list endpoint.
 *
 * Exported for rows read on a dedicated {@link connect} connection, which
 * bypasses {@link select}.
 */
export function parseJsonColumns<T extends Record<string, unknown>>(
  row: T,
  jsonColumns: readonly string[]
): T {
  if (jsonColumns.length === 0) return row;

  const parsed: Record<string, unknown> = { ...row };

  for (const column of jsonColumns) {
    const value = parsed[column];
    if (typeof value !== 'string') continue;
    try {
      parsed[column] = JSON.parse(value);
    } catch {
      // Leave the raw string in place; the caller's schema will reject it with a
      // better message than a parse error thrown from the transport layer.
    }
  }

  return parsed as T;
}

/**
 * Serialise a value bound for a JSON column.
 *
 * `mysql2` would send a plain object as `[object Object]`, so objects and arrays
 * are stringified here — the write-side counterpart of {@link parseJsonColumns}.
 * `null` and `undefined` become SQL NULL rather than the string `"null"`.
 */
export function toJsonColumn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

/**
 * Stage every change and commit — `git commit` for the data. Returns the hash.
 *
 * `-Am` stages all tables and takes the message in one call. `--author` sets the
 * identity on the commit, which is what makes `dolt_log` and `dolt_blame`
 * readable afterwards; without it every commit is attributed to the server's
 * configured user.
 *
 * Returns `null` when there was nothing to commit. Dolt raises "nothing to
 * commit" as an error, but for a caller that has just run an idempotent
 * migration or a no-op update that is the expected outcome, not a failure — so
 * it is reported as a value and every other error still propagates.
 */
export async function commit(message: string, author: string): Promise<string | null> {
  try {
    const result = await query<unknown>("CALL DOLT_COMMIT('-Am', ?, '--author', ?)", [
      message,
      author,
    ]);

    return readCommitHash(result);
  } catch (error) {
    if (isNothingToCommit(error)) return null;
    throw error;
  }
}

/**
 * Pull the hash out of a `CALL` result.
 *
 * A stored-procedure call comes back as an array of result sets, each an array
 * of rows, and the driver flattens one level in some versions. Both shapes are
 * unwrapped here rather than asserting one.
 */
export function readCommitHash(result: unknown): string | null {
  const first = Array.isArray(result) ? result[0] : result;
  const row = Array.isArray(first) ? first[0] : first;
  const hash = (row as { hash?: unknown } | undefined)?.hash;

  return typeof hash === 'string' ? hash : null;
}

/** Dolt reports an empty commit as an error; recognise it by message. */
export function isNothingToCommit(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /nothing to commit|no changes added to commit/i.test(message);
}

/**
 * The configured database name. Throws when Dolt is not configured, like
 * {@link query}, so a caller cannot build a revision name from `undefined`.
 */
function databaseName(): string {
  const database = process.env[ENV.database];
  if (!isDoltConfigured() || !database) {
    throw new Error(
      `Dolt is not configured: set ${ENV.host} and ${ENV.database} (see .env.example).`
    );
  }
  return database;
}

/**
 * A dedicated connection outside the pool, optionally on a Dolt branch.
 *
 * With `branch` the connection opens the revision database `<db>/<branch>`, so
 * every statement on it reads and writes that branch's working set, not the
 * `main` working set the pool's connections share. The branch is fixed for the
 * connection's life: no `USE` or `DOLT_CHECKOUT` state can leak into a pooled
 * connection another request picks up next. The caller owns the connection
 * and must `end()` it.
 *
 * `lib/runs.ts` uses it so each enrichment run writes on its own branch, and
 * one run's `DOLT_COMMIT('-Am')` cannot sweep up another run's rows.
 */
export async function connect(branch?: string): Promise<mysql.Connection> {
  const database = databaseName();
  // `connectionLimit` is a pool option; a single connection rejects nothing
  // but has no use for it.
  const { connectionLimit, ...options } = config();
  void connectionLimit;

  return mysql.createConnection({
    ...options,
    database: branch ? `${database}/${branch}` : database,
  });
}
