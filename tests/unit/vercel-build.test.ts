import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { libsqlPlan, migrationPlan } from '@/scripts/vercel-build.mjs';

/** Which Vercel builds apply `db/schema.sql`. No build or database is involved. */
const DOLT = { DOLT_HOST: 'dolt.example', DOLT_DATABASE: 'fire_enrich' };

describe('migrationPlan', () => {
  it('migrates a production build that has a Dolt database', () => {
    expect(migrationPlan({ VERCEL_ENV: 'production', ...DOLT }).migrate).toBe(true);
  });

  it('skips every build with no DOLT_* at all, and says Dolt is optional', () => {
    for (const env of [
      { VERCEL_ENV: 'production' },
      { VERCEL_ENV: 'preview', DOLT_PREVIEW_MIGRATE: '1' },
      { VERCEL_ENV: 'development' },
      {},
      // Tuning variables alone do not mean Dolt was meant to be on.
      { VERCEL_ENV: 'production', DOLT_COMMIT_AUTHOR: 'A <a@example.com>' },
      // Whitespace-only values count as unset.
      { VERCEL_ENV: 'production', DOLT_HOST: '  ', DOLT_DATABASE: '\t' },
    ]) {
      const plan = migrationPlan(env);
      expect(plan.migrate).toBe(false);
      expect(plan.fail).toBeUndefined();
      expect(plan.reason).toBe('Dolt is not configured (optional; set DOLT_HOST and DOLT_DATABASE to enable it)');
    }
  });

  it.each([
    ['DOLT_HOST only', { DOLT_HOST: 'dolt.example' }, ['DOLT_DATABASE']],
    ['DOLT_DATABASE only', { DOLT_DATABASE: 'fire_enrich' }, ['DOLT_HOST']],
    ['DOLT_HOST and DOLT_PASSWORD, no DOLT_DATABASE', { DOLT_HOST: 'dolt.example', DOLT_PASSWORD: 'pw' }, ['DOLT_DATABASE']],
    ['DOLT_USER and DOLT_PORT only', { DOLT_USER: 'app', DOLT_PORT: '3306' }, ['DOLT_HOST', 'DOLT_DATABASE']],
    ['DOLT_TLS_CA_B64 only', { DOLT_TLS_CA_B64: 'Zm9v' }, ['DOLT_HOST', 'DOLT_DATABASE']],
    ['a whitespace-only DOLT_HOST', { DOLT_HOST: '   ', DOLT_DATABASE: 'fire_enrich' }, ['DOLT_HOST']],
    ['a whitespace-only DOLT_DATABASE', { DOLT_HOST: 'dolt.example', DOLT_DATABASE: ' ' }, ['DOLT_DATABASE']],
  ])('fails every build with a partial Dolt: %s', (_label, dolt, missing) => {
    for (const target of ['production', 'preview', 'development', undefined]) {
      const plan = migrationPlan({ VERCEL_ENV: target, ...dolt });

      expect(plan.migrate).toBe(false);
      expect(plan.fail).toBe(true);
      expect(plan.reason).toMatch(/^Dolt is misconfigured: /);
      expect(plan.reason).toContain(`${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing`);
    }
  });

  it('never migrates a preview build by default, even with Dolt configured', () => {
    const plan = migrationPlan({ VERCEL_ENV: 'preview', ...DOLT });

    expect(plan.migrate).toBe(false);
    expect(plan.reason).toContain('DOLT_PREVIEW_MIGRATE=1');
  });

  it('migrates a preview build only with DOLT_PREVIEW_MIGRATE=1', () => {
    expect(migrationPlan({ VERCEL_ENV: 'preview', DOLT_PREVIEW_MIGRATE: '1', ...DOLT }).migrate).toBe(true);
    expect(migrationPlan({ VERCEL_ENV: 'preview', DOLT_PREVIEW_MIGRATE: 'true', ...DOLT }).migrate).toBe(false);
    expect(migrationPlan({ VERCEL_ENV: 'preview', DOLT_PREVIEW_MIGRATE: '1' }).migrate).toBe(false);
  });

  it('ignores DOLT_PREVIEW_MIGRATE outside preview', () => {
    expect(migrationPlan({ VERCEL_ENV: 'development', DOLT_PREVIEW_MIGRATE: '1', ...DOLT }).migrate).toBe(false);
  });

  it('never migrates a local or development build', () => {
    expect(migrationPlan({ ...DOLT }).migrate).toBe(false);
    expect(migrationPlan({ VERCEL_ENV: 'development', ...DOLT }).migrate).toBe(false);
  });
});

/** Which Vercel builds apply the app's libSQL schema: the Dolt rule, with its own Preview flag. */
describe('libsqlPlan', () => {
  const TURSO = { TURSO_DATABASE_URL: 'libsql://db.example' };

  it('migrates a production build that has a Turso database', () => {
    expect(libsqlPlan({ VERCEL_ENV: 'production', ...TURSO })).toEqual({ migrate: true, reason: 'production build' });
  });

  it('never migrates a preview build by default', () => {
    const plan = libsqlPlan({ VERCEL_ENV: 'preview', ...TURSO });

    expect(plan.migrate).toBe(false);
    expect(plan.reason).toContain('LIBSQL_PREVIEW_MIGRATE=1');
  });

  it('migrates a preview build only with LIBSQL_PREVIEW_MIGRATE=1', () => {
    expect(libsqlPlan({ VERCEL_ENV: 'preview', LIBSQL_PREVIEW_MIGRATE: '1', ...TURSO }).migrate).toBe(true);
    expect(libsqlPlan({ VERCEL_ENV: 'preview', LIBSQL_PREVIEW_MIGRATE: 'true', ...TURSO }).migrate).toBe(false);
    // The Dolt flag is not the libSQL one.
    expect(libsqlPlan({ VERCEL_ENV: 'preview', DOLT_PREVIEW_MIGRATE: '1', ...TURSO }).migrate).toBe(false);
  });

  it('never migrates a local or development build, flag or not', () => {
    expect(libsqlPlan({ ...TURSO }).migrate).toBe(false);
    expect(libsqlPlan({ VERCEL_ENV: 'development', LIBSQL_PREVIEW_MIGRATE: '1', ...TURSO }).migrate).toBe(false);
  });

  it('skips when TURSO_DATABASE_URL is unset, empty or whitespace', () => {
    for (const TURSO_DATABASE_URL of [undefined, '', '  ']) {
      const plan = libsqlPlan({ VERCEL_ENV: 'production', TURSO_DATABASE_URL });
      expect(plan.migrate).toBe(false);
      expect(plan.reason).toBe('TURSO_DATABASE_URL is not set');
    }
  });

  it('migrates a production build whose Turso pair carries a Marketplace prefix', () => {
    const env = { VERCEL_ENV: 'production', FIRE_TURSO_DATABASE_URL: 'libsql://db.example', FIRE_TURSO_AUTH_TOKEN: 'tok' };

    expect(libsqlPlan(env)).toEqual({ migrate: true, reason: 'production build' });
  });

  it('skips a mixed pair as unset', () => {
    const plan = libsqlPlan({ VERCEL_ENV: 'production', FIRE_TURSO_DATABASE_URL: 'libsql://db.example', TURSO_AUTH_TOKEN: 'tok' });

    expect(plan).toEqual({ migrate: false, reason: 'TURSO_DATABASE_URL is not set' });
  });

  it('fails on two prefixed pairs and no plain url', () => {
    const plan = libsqlPlan({
      VERCEL_ENV: 'production',
      A_TURSO_DATABASE_URL: 'libsql://a.example',
      A_TURSO_AUTH_TOKEN: 'tok-a',
      B_TURSO_DATABASE_URL: 'libsql://b.example',
      B_TURSO_AUTH_TOKEN: 'tok-b',
    });

    expect(plan.migrate).toBe(false);
    expect(plan.fail).toBe(true);
    expect(plan.reason).toContain('A_TURSO_DATABASE_URL, B_TURSO_DATABASE_URL');
  });
});

/**
 * The script end to end, as Vercel runs it, in a child process. `next build`
 * is replaced by a stub: the script runs `npm_execpath run build` with this
 * Node, so pointing `npm_execpath` at a file that prints a marker and exits 0
 * stands in for a build that succeeded. The migration is the real
 * `scripts/db-migrate.mjs`.
 */
describe('vercel-build main()', { timeout: 30_000 }, () => {
  const SCRIPT = fileURLToPath(new URL('../../scripts/vercel-build.mjs', import.meta.url));
  const REPO = fileURLToPath(new URL('../../', import.meta.url));
  const BUILT = 'stub next build ran';
  const DOLT_ENV = ['DOLT_HOST', 'DOLT_PORT', 'DOLT_USER', 'DOLT_PASSWORD', 'DOLT_DATABASE', 'DOLT_TLS_CA_B64', 'DOLT_PREVIEW_MIGRATE'];
  // Unset per build unless a test passes them: tests/setup.ts points
  // TURSO_DATABASE_URL at the suite's own file.
  const TURSO_ENV = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'LIBSQL_PREVIEW_MIGRATE'];
  let dir: string;
  let stub: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vercel-build-'));
    stub = join(dir, 'npm-stub.mjs');
    writeFileSync(stub, `console.log(${JSON.stringify(BUILT)});\n`);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function build(extra: Record<string, string>, cwd?: string, unset: string[] = []) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [...DOLT_ENV, ...TURSO_ENV, ...unset]) delete env[key];
    // Windows env names are case-insensitive, and the parent's copy may be
    // spelled differently; drop every spelling so the stub is the only one.
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_execpath') delete env[key];
    return spawnSync(process.execPath, [SCRIPT], {
      cwd,
      encoding: 'utf8',
      env: { ...env, npm_execpath: stub, ...extra },
      timeout: 20_000,
    });
  }

  it('builds, skips the migration, and exits 0 with no Dolt configured', () => {
    const result = build({ VERCEL_ENV: 'production' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(BUILT);
    expect(result.stdout).toContain('db:migrate skipped: Dolt is not configured (optional;');
    expect(result.stdout).toContain('db:migrate:libsql skipped: TURSO_DATABASE_URL is not set.');
  });

  it('applies the libSQL schema when TURSO_DATABASE_URL is set, and a rebuild changes nothing', () => {
    const turso = { VERCEL_ENV: 'production', TURSO_DATABASE_URL: `file:${join(dir, 'build.db')}` };

    const first = build(turso);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(BUILT);
    expect(first.stdout).toContain('db:migrate:libsql: production build.');
    expect(first.stdout).toContain('created index:idx_profiles_created_at');
    expect(first.stdout).toContain('table:profiles');
    expect(first.stdout).toContain('table:research_plans');

    const second = build(turso);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('nothing changed.');
  });

  it('applies the libSQL schema to the pair the Marketplace integration sets under a custom prefix', () => {
    const result = build({
      VERCEL_ENV: 'production',
      FIRE_TURSO_DATABASE_URL: `file:${join(dir, 'prefixed.db')}`,
      FIRE_TURSO_AUTH_TOKEN: 'stub-token',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('db:migrate:libsql: production build.');
    expect(result.stdout).toContain('prefixed.db: ');
    expect(result.stdout).toContain('table:profiles');
  });

  it('fails before building when two prefixed Turso pairs are set and no plain one', () => {
    const result = build({
      VERCEL_ENV: 'production',
      A_TURSO_DATABASE_URL: `file:${join(dir, 'a.db')}`,
      A_TURSO_AUTH_TOKEN: 'stub-a',
      B_TURSO_DATABASE_URL: `file:${join(dir, 'b.db')}`,
      B_TURSO_AUTH_TOKEN: 'stub-b',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(BUILT);
    expect(result.stderr).toContain('db:migrate:libsql: Turso is ambiguous: A_TURSO_DATABASE_URL, B_TURSO_DATABASE_URL');
  });

  it('skips the libSQL migration on a preview build without LIBSQL_PREVIEW_MIGRATE', () => {
    const result = build({ VERCEL_ENV: 'preview', TURSO_DATABASE_URL: `file:${join(dir, 'preview.db')}` });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('db:migrate:libsql skipped: preview build; set LIBSQL_PREVIEW_MIGRATE=1');
  });

  it('exits non-zero, before any Dolt migration, when the libSQL migration fails', () => {
    // Port 1 on loopback: nothing listens, the connection is refused at once.
    const result = build({
      VERCEL_ENV: 'production',
      TURSO_DATABASE_URL: 'http://127.0.0.1:1',
      DOLT_HOST: '127.0.0.1',
      DOLT_PORT: '1',
      DOLT_DATABASE: 'fire_enrich',
    });

    expect(result.stdout).toContain(BUILT);
    expect(result.stderr).toContain('libSQL migration failed.');
    expect(result.stdout).not.toContain('db:migrate: production build.');
    expect(result.status).toBe(1);
  });

  it('exits non-zero when Dolt is configured and the migration fails', () => {
    // Port 1 on loopback: nothing listens, the connection is refused at once.
    const result = build({ VERCEL_ENV: 'production', DOLT_HOST: '127.0.0.1', DOLT_PORT: '1', DOLT_DATABASE: 'fire_enrich' });

    expect(result.stdout).toContain(BUILT);
    expect(result.stdout).toContain('db:migrate: production build.');
    expect(result.stderr).toContain('Migration failed against 127.0.0.1:1/fire_enrich');
    expect(result.status).toBe(1);
  });

  it('runs the migrations without the env files in its project root, so only the platform variables reach them', () => {
    // A local `vercel build` runs in a checkout that has a developer's env
    // files. The directory stands in for that project root: the real npm
    // scripts in a package.json and a junction to the real scripts/, so a
    // migration started through `npm run db:migrate:libsql` would read the
    // env files here, as that npm script does.
    const root = mkdtempSync(join(dir, 'project-'));
    const { scripts } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'env-isolation', private: true, scripts }));
    symlinkSync(join(REPO, 'scripts'), join(root, 'scripts'), 'junction');

    // A file-only variable that shows in the output if it reaches a child:
    // Node applies NODE_OPTIONS from an env file, and this one prints a marker.
    const marker = join(root, 'leak.cjs');
    writeFileSync(marker, "console.log('ENV FILE LEAKED');\n");
    const leak = `NODE_OPTIONS=--require ${marker.replace(/\\/g, '/')}\n`;
    writeFileSync(join(root, '.env'), leak);
    writeFileSync(join(root, '.env.local'), leak);

    const platformDb = join(root, 'platform.db');
    const env: Record<string, string> = { VERCEL_ENV: 'production', TURSO_DATABASE_URL: `file:${platformDb}` };
    const result = build(env, root, ['NODE_OPTIONS']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(BUILT);
    // The libSQL migration ran, as a real child, against the platform's url.
    expect(result.stdout).toContain('db:migrate:libsql: production build.');
    expect(result.stdout).toContain('platform.db: ');
    expect(result.stdout).toContain('table:profiles');
    // And the env files never reached it.
    expect(`${result.stdout}${result.stderr}`).not.toContain('ENV FILE LEAKED');
  });

  it('fails before building on a partial Dolt, naming the missing variable', () => {
    const result = build({ VERCEL_ENV: 'production', DOLT_HOST: '127.0.0.1', DOLT_PASSWORD: 'pw' });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(BUILT);
    expect(result.stderr).toContain('Dolt is misconfigured: DOLT_HOST, DOLT_PASSWORD are set but DOLT_DATABASE is missing');
  });
});
