import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The certificate host check in `scripts/db-migrate.mjs`, with `mysql2`
 * replaced by fake connections: nothing opens a socket. The script runs its
 * migration on import, so each test sets the environment, imports a fresh
 * copy, and waits for it to log or exit.
 */
const { createConnection } = vi.hoisted(() => ({ createConnection: vi.fn() }));

vi.mock('mysql2/promise', () => ({ default: { createConnection } }));

const DOLT_ENV = ['DOLT_HOST', 'DOLT_PORT', 'DOLT_USER', 'DOLT_PASSWORD', 'DOLT_DATABASE', 'DOLT_TLS_CA_B64'] as const;
const saved: Partial<Record<(typeof DOLT_ENV)[number], string | undefined>> = {};

/** Fake connections whose TLS socket presents a certificate for `san`. */
function serverPresenting(san: string) {
  const connections: Array<{ query: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = [];
  createConnection.mockImplementation(async (options: { ssl?: object }) => {
    const connection = {
      connection: {
        config: { ssl: options.ssl },
        stream: {
          getPeerCertificate: () => ({ subject: { CN: 'fire-enrich-dolt' }, subjectaltname: san }),
          isSessionReused: () => false,
        },
      },
      query: vi.fn(async (sql: string) => {
        if (/SCHEMATA/.test(sql)) return [[{ SCHEMA_NAME: 'fire_enrich' }], []];
        return [[], []];
      }),
      end: vi.fn(async () => {}),
      destroy: vi.fn(),
    };
    connections.push(connection);
    return connection;
  });
  return connections;
}

async function runScript() {
  vi.resetModules();
  await import('../../scripts/db-migrate.mjs');
}

let exit: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const key of DOLT_ENV) saved[key] = process.env[key];
  process.env.DOLT_HOST = '203.0.113.10';
  process.env.DOLT_PORT = '3306';
  process.env.DOLT_USER = 'fire_enrich';
  process.env.DOLT_PASSWORD = 'unused';
  process.env.DOLT_DATABASE = 'fire_enrich';
  process.env.DOLT_TLS_CA_B64 = Buffer.from('ca').toString('base64');
  createConnection.mockReset();
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  exit.mockRestore();
  log.mockRestore();
  error.mockRestore();
  for (const key of DOLT_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('db-migrate certificate host check', () => {
  it('refuses a server whose certificate names another address, before any statement', async () => {
    const connections = serverPresenting('IP Address:198.51.100.7');

    await runScript();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(connections).toHaveLength(1);
    expect(connections[0].destroy).toHaveBeenCalled();
    expect(connections[0].query).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join('\n')).toMatch(/does not match certificate's altnames/);
  });

  it('migrates when the certificate names DOLT_HOST', async () => {
    const connections = serverPresenting('IP Address:203.0.113.10');

    await runScript();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining('nothing changed')));

    expect(exit).not.toHaveBeenCalled();
    expect(connections).toHaveLength(2);
    expect(connections.every((connection) => connection.destroy.mock.calls.length === 0)).toBe(true);
    // An IP host: mysql2's own name check stays off; the script's check runs instead.
    expect(createConnection.mock.calls[0][0].ssl.verifyIdentity).toBe(false);
  });
});
