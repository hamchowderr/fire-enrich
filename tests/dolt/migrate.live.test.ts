import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `scripts/db-migrate.mjs` against a real Dolt server.
 *
 * Skipped unless `DOLT_TEST_HOST` and `DOLT_TEST_DATABASE` are set, so the
 * normal suite never needs a database. CI sets them against a throwaway
 * `dolthub/dolt-sql-server` container, after applying the base branch's
 * `db/schema.sql` to `DOLT_TEST_DATABASE`, so the first migration here is the
 * upgrade a production deploy would run.
 *
 * Never point these variables at a database whose data matters: the test
 * creates and drops a second database next to it.
 */
const host = process.env.DOLT_TEST_HOST;
const database = process.env.DOLT_TEST_DATABASE;
const port = Number(process.env.DOLT_TEST_PORT ?? 3306);
const user = process.env.DOLT_TEST_USER ?? 'root';
const password = process.env.DOLT_TEST_PASSWORD ?? '';

const SCRIPT = fileURLToPath(new URL('../../scripts/db-migrate.mjs', import.meta.url));
const FRESH = `fe_migrate_fresh_${process.pid}`;

function migrate(target: string) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DOLT_HOST: host,
      DOLT_PORT: String(port),
      DOLT_USER: user,
      DOLT_PASSWORD: password,
      DOLT_DATABASE: target,
    },
  });
}

let connection: mysql.Connection;

async function head(target: string): Promise<string> {
  const [rows] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT commit_hash FROM \`${target}\`.dolt_log ORDER BY date DESC LIMIT 1`
  );
  return rows[0].commit_hash as string;
}

/** Every table's `SHOW CREATE TABLE`, keyed by name. */
async function shape(target: string): Promise<Record<string, string>> {
  const [tables] = await connection.query<mysql.RowDataPacket[]>(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    [target]
  );
  const out: Record<string, string> = {};
  for (const { name } of tables) {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(
      `SHOW CREATE TABLE \`${target}\`.\`${name}\``
    );
    out[name] = rows[0]['Create Table'] as string;
  }
  return out;
}

describe.skipIf(!host || !database)('db-migrate against a live Dolt server', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    connection = await mysql.createConnection({ host, port, user, password });
  });

  afterAll(async () => {
    await connection?.query(`DROP DATABASE IF EXISTS \`${FRESH}\``);
    await connection?.end();
  });

  it('upgrades the base schema, then a second run changes nothing and commits nothing', async () => {
    const first = migrate(database!);
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);

    const before = await head(database!);
    const second = migrate(database!);

    expect(second.status).toBe(0);
    expect(second.stdout).toContain('nothing changed');
    expect(await head(database!)).toBe(before);

    const [status] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT * FROM \`${database}\`.dolt_status`
    );
    expect(status).toEqual([]);
  });

  it('leaves the upgraded database the same shape as a fresh one', async () => {
    const fresh = migrate(FRESH);
    expect(fresh.status).toBe(0);

    expect(await shape(database!)).toEqual(await shape(FRESH));
  });
});
