import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient } from '@libsql/client';
import { describe, expect, it } from 'vitest';

import { APP_DB_STATEMENTS, applyAppDbSchema } from '@/lib/app-db-schema.mjs';

/**
 * The app's libSQL schema and its migration, against real files, and the
 * Dolt schema's side of the move: profiles and plans are no longer created
 * there, and runs no longer reference plans by foreign key.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/libsql-migrate.mjs', import.meta.url));
const DOLT_SCHEMA = fileURLToPath(new URL('../../db/schema.sql', import.meta.url));

function tempUrl(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fire-enrich-schema-'));
  return `file:${path.join(dir, 'app.db')}`;
}

function migrate(env: Record<string, string>) {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  delete clean.TURSO_DATABASE_URL;
  delete clean.TURSO_AUTH_TOKEN;
  return spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...clean, ...env }, timeout: 20_000 });
}

describe('applyAppDbSchema', () => {
  it('creates the tables and indexes, and a second run creates nothing', async () => {
    const client = createClient({ url: tempUrl() });
    try {
      const first = await applyAppDbSchema(client);
      expect(first).toEqual(
        expect.arrayContaining([
          'table:profiles',
          'table:research_plans',
          'index:uq_profiles_name',
          'index:idx_profiles_created_at',
          'index:idx_research_plans_profile_id',
          'index:idx_research_plans_created_at',
        ])
      );

      expect(await applyAppDbSchema(client)).toEqual([]);
    } finally {
      client.close();
    }
  });

  it('keeps existing rows and leaves Mastra tables alone', async () => {
    const client = createClient({ url: tempUrl() });
    try {
      await client.execute('CREATE TABLE mastra_threads (id TEXT PRIMARY KEY)');
      await client.execute("INSERT INTO mastra_threads VALUES ('t1')");
      await applyAppDbSchema(client);
      await client.execute(
        `INSERT INTO profiles (id, name, business_summary, offer, audiences, default_field_hints, crm_defaults, models)
         VALUES ('p1', 'Co', 's', 'o', '[]', '[]', '{}', '{}')`
      );

      expect(await applyAppDbSchema(client)).toEqual([]);

      const profiles = await client.execute('SELECT id FROM profiles');
      const threads = await client.execute('SELECT id FROM mastra_threads');
      expect(profiles.rows.map((row) => row.id)).toEqual(['p1']);
      expect(threads.rows.map((row) => row.id)).toEqual(['t1']);
    } finally {
      client.close();
    }
  });

  it('rejects a JSON column that does not hold JSON', async () => {
    const client = createClient({ url: tempUrl() });
    try {
      await applyAppDbSchema(client);

      await expect(
        client.execute(
          `INSERT INTO profiles (id, name, business_summary, offer, audiences, default_field_hints, crm_defaults, models)
           VALUES ('p1', 'Co', 's', 'o', 'not json', '[]', '{}', '{}')`
        )
      ).rejects.toThrow(/CHECK constraint failed/);
    } finally {
      client.close();
    }
  });

  it('only ever creates, never drops or alters', () => {
    for (const statement of APP_DB_STATEMENTS) {
      expect(statement).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS /);
    }
  });
});

describe('npm run db:migrate:libsql', { timeout: 30_000 }, () => {
  it('migrates the database TURSO_DATABASE_URL names, then reports nothing changed', () => {
    const url = tempUrl();

    const first = migrate({ TURSO_DATABASE_URL: url });
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`libSQL ${url}: ${APP_DB_STATEMENTS.length} statements applied, created`);
    expect(first.stdout).toContain('table:profiles');

    const second = migrate({ TURSO_DATABASE_URL: url });
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('nothing changed.');
  });

  it('exits 1 when the database cannot be reached, so the build fails', () => {
    // Port 1 on loopback: nothing listens, the connection is refused at once.
    const result = migrate({ TURSO_DATABASE_URL: 'http://127.0.0.1:1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('libSQL migration failed.');
  });
});

describe('db/schema.sql (Dolt) after profiles and plans moved to libSQL', () => {
  const sql = readFileSync(DOLT_SCHEMA, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  it('creates only the run-history tables', () => {
    const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1]);

    expect(created).toEqual(['enrichment_runs', 'enrichments', 'evidence']);
  });

  it('never drops a table, so an existing profiles or research_plans table is left in place', () => {
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
  });

  it('declares no foreign key to research_plans, and drops the old one if present', () => {
    expect(sql).not.toMatch(/REFERENCES\s+research_plans/i);
    expect(sql).not.toMatch(/ADD CONSTRAINT fk_enrichment_runs_plan/);
    expect(sql).toContain('ALTER TABLE enrichment_runs DROP FOREIGN KEY fk_enrichment_runs_plan');
  });
});
