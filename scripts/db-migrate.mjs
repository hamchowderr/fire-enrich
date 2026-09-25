#!/usr/bin/env node
/**
 * Apply `db/schema.sql` to a Dolt database and commit the result.
 *
 *   DOLT_HOST=127.0.0.1 DOLT_PORT=3306 DOLT_USER=root DOLT_PASSWORD= \
 *   DOLT_DATABASE=fire_enrich npm run db:migrate
 *
 * Three steps, in order:
 *
 *   1. `CREATE DATABASE` on a connection with no database selected, only
 *      when the database does not exist yet (the hosted app user may not
 *      create databases, but owns the ones that exist).
 *   2. Every statement in `db/schema.sql`, each already `IF NOT EXISTS`.
 *   3. `DOLT_COMMIT` — but only if step 2 actually changed something.
 *
 * Re-running is a no-op: the schema statements do nothing and no commit is
 * written, so `dolt_log` gets one entry per real schema change rather than one
 * per invocation. "Did anything change?" is answered by `dolt_status`, which is
 * Dolt's own view of the working set, rather than by guessing from the DDL.
 *
 * Plain `.mjs` with no dependency on the app's TypeScript: it runs by hand, and
 * on Vercel from `scripts/vercel-build.mjs` after `next build` and before the
 * deployment receives traffic, possibly against a database the app has not
 * connected to yet.
 */
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2/promise';

import {
  DOLT_REQUIRED_VARS,
  doltAccessDeniedHint,
  doltConfigState,
  doltMisconfiguredMessage,
} from '../lib/dolt-config.mjs';

const SCHEMA_PATH = fileURLToPath(new URL('../db/schema.sql', import.meta.url));
const AUTHOR = 'Fire Enrich Migrate <fire-enrich@localhost>';

const host = process.env.DOLT_HOST ?? '127.0.0.1';
const port = Number(process.env.DOLT_PORT ?? 3306);
const user = process.env.DOLT_USER ?? 'root';
const password = process.env.DOLT_PASSWORD ?? '';
const database = process.env.DOLT_DATABASE;
const tlsCa = process.env.DOLT_TLS_CA_B64;

// Run by hand, a migration with nothing to migrate is a mistake worth an
// error. The Vercel build checks the same thing first and skips this script
// when Dolt is not configured, so a deploy without Dolt never gets here.
const config = doltConfigState();
if (config.state === 'misconfigured') {
  console.error(`${doltMisconfiguredMessage(config)} See .env.example for the DOLT_* variables.`);
  process.exit(1);
}
if (config.state === 'off') {
  console.error(
    `Dolt is not configured: set ${DOLT_REQUIRED_VARS.join(' and ')}. See .env.example for the DOLT_* variables.`
  );
  process.exit(1);
}

// Mirrors lib/dolt.ts: pass the CA so verification stays on against the hosted
// server's self-signed certificate. Unset locally, where there is no TLS.
const ssl = tlsCa ? { ca: Buffer.from(tlsCa, 'base64') } : undefined;
const base = { host, port, user, password, ...(ssl ? { ssl } : {}) };

/**
 * Split the schema file into statements.
 *
 * Comment lines go first so a `;` inside a comment cannot end a statement. The
 * schema file is written to suit this splitter — one statement per `;` at end of
 * line, no `;` inside a literal — which is why it says so at the top.
 */
function statements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** Tables and views with uncommitted changes, per Dolt's own working-set view. */
async function dirtyTables(connection) {
  const [rows] = await connection.query('SELECT table_name, status FROM dolt_status');
  return rows;
}

async function main() {
  // Step 1 needs a connection with no database selected: `USE fire_enrich`
  // would fail on a server that has never seen it. Only create when the
  // database is missing: the hosted app user owns its databases but has no
  // server-wide CREATE right, so an unconditional CREATE DATABASE is denied
  // even though the database already exists.
  const admin = await mysql.createConnection(base);
  try {
    const [found] = await admin.query(
      'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [database]
    );
    if (found.length === 0) {
      await admin.query(`CREATE DATABASE \`${database}\``);
    }
  } finally {
    await admin.end();
  }

  const connection = await mysql.createConnection({ ...base, database });
  try {
    const schema = statements(await readFile(SCHEMA_PATH, 'utf8'));
    for (const statement of schema) await connection.query(statement);

    const dirty = await dirtyTables(connection);
    if (dirty.length === 0) {
      console.log(
        `${database}: ${schema.length} statements applied, nothing changed — no commit.`
      );
      return;
    }

    const message = `Apply db/schema.sql (${dirty.length} tables changed)`;
    const [result] = await connection.query("CALL DOLT_COMMIT('-Am', ?, '--author', ?)", [
      message,
      AUTHOR,
    ]);
    const hash = result?.[0]?.[0]?.hash ?? result?.[0]?.hash ?? '(unknown)';

    console.log(
      `${database}: ${schema.length} statements applied, ` +
        `${dirty.length} tables changed (${dirty.map((row) => row.table_name).join(', ')}).`
    );
    console.log(`Committed ${hash}`);
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`Migration failed against ${host}:${port}/${database}`);
  console.error(`${error instanceof Error ? error.message : error}${doltAccessDeniedHint(error)}`);
  process.exit(1);
});
