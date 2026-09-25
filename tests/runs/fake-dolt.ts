import { vi } from 'vitest';

/**
 * A fake Dolt behind `mysql2/promise`: the pool and every dedicated
 * connection write into one ordered statement log, tagged with the database
 * the connection opened (`fire_enrich` for `main`, `fire_enrich/run/<id>` for
 * a run's branch). Tests assert on that log: which SQL ran, with what
 * parameters, on which branch, in what order.
 *
 * Results are answered by {@link FakeDolt.respond} handlers, first match wins;
 * a handler that throws makes that statement fail. Without a handler a
 * `DOLT_COMMIT` answers a fresh hash, a `DOLT_MERGE` a clean merge, and
 * anything else an empty result.
 */
export interface Statement {
  /** `pool` or the database a dedicated connection opened. */
  on: string;
  sql: string;
  params: unknown[];
}

type Handler = (statement: Statement) => unknown;

export interface FakeDolt {
  log: Statement[];
  /** Hashes answered to `DOLT_COMMIT`, in order. */
  hashes: string[];
  connections: Array<{ database: string; end: ReturnType<typeof vi.fn> }>;
  respond(match: RegExp, handler: Handler): void;
  /** Statements matching `pattern`, optionally only on one connection. */
  find(pattern: RegExp, on?: string | RegExp): Statement[];
  reset(): void;
}

export function installFakeDolt(createPool: ReturnType<typeof vi.fn>, createConnection: ReturnType<typeof vi.fn>): FakeDolt {
  const handlers: Array<{ match: RegExp; handler: Handler }> = [];
  let counter = 0;

  const fake: FakeDolt = {
    log: [],
    hashes: [],
    connections: [],
    respond(match, handler) {
      handlers.push({ match, handler });
    },
    find(pattern, on) {
      return fake.log.filter(
        (statement) =>
          pattern.test(statement.sql) &&
          (on === undefined || (typeof on === 'string' ? statement.on === on : on.test(statement.on)))
      );
    },
    reset() {
      handlers.length = 0;
      fake.log.length = 0;
      fake.hashes.length = 0;
      fake.connections.length = 0;
      counter = 0;
    },
  };

  const run = async (on: string, sql: string, params: unknown[] = []) => {
    const statement = { on, sql, params };
    fake.log.push(statement);
    // Yield, so statements from concurrent callers can interleave as they
    // would against a real server.
    await Promise.resolve();

    const handler = handlers.find((candidate) => candidate.match.test(sql));
    if (handler) return [await handler.handler(statement), []];

    if (/DOLT_COMMIT/.test(sql)) {
      counter += 1;
      const hash = `hash${String(counter).padStart(4, '0')}`;
      fake.hashes.push(hash);
      return [[[{ hash }], { affectedRows: 0 }], []];
    }
    if (/DOLT_MERGE/.test(sql)) return [[[{ hash: '', fast_forward: 0, conflicts: 0, message: 'merge successful' }]], []];
    return [[], []];
  };

  createPool.mockImplementation(() => ({
    query: vi.fn((sql: string, params?: unknown[]) => run('pool', sql, params)),
    end: vi.fn(async () => {}),
  }));

  createConnection.mockImplementation(async (options: { database: string }) => {
    const connection = {
      database: options.database,
      query: vi.fn((sql: string, params?: unknown[]) => run(options.database, sql, params)),
      end: vi.fn(async () => {}),
    };
    fake.connections.push(connection);
    return connection;
  });

  return fake;
}

export const DOLT_ENV = ['DOLT_HOST', 'DOLT_PORT', 'DOLT_USER', 'DOLT_PASSWORD', 'DOLT_DATABASE', 'DOLT_COMMIT_AUTHOR'] as const;

/** Save and clear the Dolt environment; returns the restore function. */
export function isolateDoltEnv(): () => void {
  const saved = Object.fromEntries(DOLT_ENV.map((key) => [key, process.env[key]]));
  for (const key of DOLT_ENV) delete process.env[key];
  return () => {
    for (const key of DOLT_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

export function configureDolt(): void {
  process.env.DOLT_HOST = '127.0.0.1';
  process.env.DOLT_PORT = '3316';
  process.env.DOLT_USER = 'root';
  process.env.DOLT_PASSWORD = '';
  process.env.DOLT_DATABASE = 'fire_enrich';
}
