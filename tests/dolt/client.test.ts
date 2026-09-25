import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Dolt client with `mysql2` replaced by a fake pool.
 *
 * Nothing here opens a socket: the point is the client's own behaviour — when it
 * decides Dolt is configured, what it puts in `createPool`, how it unwraps a
 * `CALL` result, and where JSON crosses the transport — all of which a live
 * server would hide rather than prove.
 */
const createPool = vi.fn();

vi.mock('mysql2/promise', () => ({ default: { createPool } }));

const DOLT_ENV = [
  'DOLT_HOST',
  'DOLT_PORT',
  'DOLT_USER',
  'DOLT_PASSWORD',
  'DOLT_DATABASE',
  'DOLT_TLS_CA_B64',
] as const;

const saved: Partial<Record<(typeof DOLT_ENV)[number], string | undefined>> = {};

/** A pool whose `query` returns whatever the test queued, recording every call. */
function fakePool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const results: unknown[] = [];

  const pool = {
    calls,
    queue: (result: unknown) => results.push(result),
    end: vi.fn(async () => {}),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return [results.shift() ?? [], []];
    }),
  };

  createPool.mockReturnValue(pool);
  return pool;
}

/**
 * Import a fresh copy of the client.
 *
 * The pool is cached in a module-level variable, so a test that changes the
 * environment must also get a module that has not already built a pool from the
 * old one.
 */
async function loadClient() {
  vi.resetModules();
  return import('@/lib/dolt');
}

beforeEach(() => {
  for (const key of DOLT_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  createPool.mockReset();
});

afterEach(() => {
  for (const key of DOLT_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('isDoltConfigured', () => {
  it('is false when nothing is set, so the app boots without Dolt', async () => {
    const { isDoltConfigured } = await loadClient();

    expect(isDoltConfigured()).toBe(false);
  });

  it('is false when only one of host and database is set', async () => {
    process.env.DOLT_HOST = '127.0.0.1';
    const { isDoltConfigured } = await loadClient();

    expect(isDoltConfigured()).toBe(false);
  });

  it('is true with host and database set, even with an empty password', async () => {
    process.env.DOLT_HOST = '127.0.0.1';
    process.env.DOLT_DATABASE = 'fire_enrich';
    process.env.DOLT_PASSWORD = '';
    const { isDoltConfigured } = await loadClient();

    expect(isDoltConfigured()).toBe(true);
  });

  it('throws instead of connecting when a query runs unconfigured', async () => {
    const { query } = await loadClient();

    await expect(query('SELECT 1')).rejects.toThrow(/not configured/i);
    expect(createPool).not.toHaveBeenCalled();
  });
});

describe('pool configuration', () => {
  beforeEach(() => {
    process.env.DOLT_HOST = 'dolt.example';
    process.env.DOLT_PORT = '3307';
    process.env.DOLT_USER = 'enrich';
    process.env.DOLT_PASSWORD = 'unused-in-this-test';
    process.env.DOLT_DATABASE = 'fire_enrich';
  });

  it('builds the pool from the environment on first use, not on import', async () => {
    fakePool();
    const { query } = await loadClient();

    expect(createPool).not.toHaveBeenCalled();

    await query('SELECT 1');

    expect(createPool).toHaveBeenCalledTimes(1);
    expect(createPool.mock.calls[0][0]).toMatchObject({
      host: 'dolt.example',
      port: 3307,
      user: 'enrich',
      database: 'fire_enrich',
      dateStrings: true,
    });
  });

  it('reuses one pool across queries', async () => {
    fakePool();
    const { query } = await loadClient();

    await query('SELECT 1');
    await query('SELECT 2');

    expect(createPool).toHaveBeenCalledTimes(1);
  });

  it('omits ssl when DOLT_TLS_CA_B64 is unset, as local dev has no TLS', async () => {
    fakePool();
    const { query } = await loadClient();

    await query('SELECT 1');

    expect(createPool.mock.calls[0][0]).not.toHaveProperty('ssl');
  });

  it('decodes DOLT_TLS_CA_B64 into ssl.ca so the self-signed CA is trusted', async () => {
    const pem = '-----BEGIN CERTIFICATE-----\nnot-a-real-certificate\n-----END CERTIFICATE-----';
    process.env.DOLT_TLS_CA_B64 = Buffer.from(pem).toString('base64');
    fakePool();
    const { query } = await loadClient();

    await query('SELECT 1');

    const { ssl } = createPool.mock.calls[0][0];
    expect(Buffer.isBuffer(ssl.ca)).toBe(true);
    expect(ssl.ca.toString()).toBe(pem);
    // Verification stays on: trusting one CA is not the same as accepting any.
    expect(ssl).not.toHaveProperty('rejectUnauthorized');
  });
});

describe('query and select', () => {
  beforeEach(() => {
    process.env.DOLT_HOST = '127.0.0.1';
    process.env.DOLT_DATABASE = 'fire_enrich';
  });

  it('binds parameters rather than interpolating them', async () => {
    const fake = fakePool();
    const { query } = await loadClient();

    await query('SELECT * FROM profiles WHERE id = ?', ["'; DROP TABLE profiles; --"]);

    expect(fake.calls[0].sql).toBe('SELECT * FROM profiles WHERE id = ?');
    expect(fake.calls[0].params).toEqual(["'; DROP TABLE profiles; --"]);
  });

  it('parses the named JSON columns of every row', async () => {
    const fake = fakePool();
    fake.queue([
      {
        id: 'a',
        audiences: '["founders","operators"]',
        crm_defaults: '{"owner":"sales"}',
        name: 'Example Co',
      },
    ]);
    const { select } = await loadClient();

    const rows = await select('SELECT 1', [], ['audiences', 'crm_defaults']);

    expect(rows[0]).toEqual({
      id: 'a',
      audiences: ['founders', 'operators'],
      crm_defaults: { owner: 'sales' },
      name: 'Example Co',
    });
  });

  it('leaves columns alone when none are named as JSON', async () => {
    const fake = fakePool();
    fake.queue([{ audiences: '["founders"]' }]);
    const { select } = await loadClient();

    expect(await select('SELECT 1')).toEqual([{ audiences: '["founders"]' }]);
  });

  it('returns an empty array when a write result header arrives instead of rows', async () => {
    const fake = fakePool();
    fake.queue({ affectedRows: 1 });
    const { select } = await loadClient();

    expect(await select('SELECT 1')).toEqual([]);
  });
});

describe('JSON round-trip across the transport', () => {
  beforeEach(() => {
    process.env.DOLT_HOST = '127.0.0.1';
    process.env.DOLT_DATABASE = 'fire_enrich';
  });

  it('stringifies on write and reads back the same value', async () => {
    const fake = fakePool();
    const { select, toJsonColumn } = await loadClient();

    const value = {
      audiences: ['founders', 'RevOps leads'],
      default_field_hints: ['funding stage', 'hiring for sales'],
      crm_defaults: { owner: 'sales', tags: ['inbound'], nested: { pipeline: 2 } },
      models: { planner: 'anthropic/claude-sonnet-4.5' },
    };

    // What the client would send for each JSON column.
    const written = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJsonColumn(item)])
    );
    for (const column of Object.values(written)) expect(typeof column).toBe('string');

    // The same strings coming back out of the driver.
    fake.queue([written]);

    expect((await select('SELECT 1', [], Object.keys(value)))[0]).toEqual(value);
  });

  it('writes null rather than the string "null" for an absent value', async () => {
    const { toJsonColumn } = await loadClient();

    expect(toJsonColumn(null)).toBeNull();
    expect(toJsonColumn(undefined)).toBeNull();
  });

  it('passes through a column the driver already parsed', async () => {
    const fake = fakePool();
    fake.queue([{ audiences: ['founders'] }]);
    const { select } = await loadClient();

    expect(await select('SELECT 1', [], ['audiences'])).toEqual([{ audiences: ['founders'] }]);
  });

  it('leaves an unparseable column as-is rather than throwing', async () => {
    const fake = fakePool();
    fake.queue([{ audiences: 'not json' }]);
    const { select } = await loadClient();

    expect(await select('SELECT 1', [], ['audiences'])).toEqual([{ audiences: 'not json' }]);
  });
});

describe('commit', () => {
  beforeEach(() => {
    process.env.DOLT_HOST = '127.0.0.1';
    process.env.DOLT_DATABASE = 'fire_enrich';
  });

  it('calls DOLT_COMMIT with the message and author bound as parameters', async () => {
    const fake = fakePool();
    fake.queue([[{ hash: 'abc123' }]]);
    const { commit } = await loadClient();

    const hash = await commit('Create profile p1 (Example Co)', 'Fire Enrich <fe@localhost>');

    expect(fake.calls[0].sql).toBe("CALL DOLT_COMMIT('-Am', ?, '--author', ?)");
    expect(fake.calls[0].params).toEqual([
      'Create profile p1 (Example Co)',
      'Fire Enrich <fe@localhost>',
    ]);
    expect(hash).toBe('abc123');
  });

  it('unwraps a hash the driver returned one level flatter', async () => {
    const fake = fakePool();
    fake.queue([{ hash: 'def456' }]);
    const { commit } = await loadClient();

    expect(await commit('m', 'a')).toBe('def456');
  });

  it('returns null when there was nothing to commit', async () => {
    const fake = fakePool();
    fake.query.mockRejectedValueOnce(new Error('nothing to commit'));
    const { commit } = await loadClient();

    expect(await commit('m', 'a')).toBeNull();
  });

  it('propagates any other failure', async () => {
    const fake = fakePool();
    fake.query.mockRejectedValueOnce(new Error('connection lost'));
    const { commit } = await loadClient();

    await expect(commit('m', 'a')).rejects.toThrow('connection lost');
  });
});
