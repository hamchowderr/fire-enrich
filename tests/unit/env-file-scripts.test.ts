import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `npm run db:migrate`, `db:migrate:libsql` and `db:sweep-runs` read `.env`
 * and `.env.local` the way the app does, and never override a variable that
 * is already set.
 *
 * Each case runs the npm script's own command line from `package.json`, with
 * the script path made absolute and a temp directory as the working
 * directory, so the env files are the test's and the repository's own
 * `.env.local` is never read. No database is reached: Dolt is pointed at
 * port 1 on loopback (refused at once) and libSQL at a temp file.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPTS: Record<string, string> = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
const CLEARED = ['DOLT_HOST', 'DOLT_PORT', 'DOLT_USER', 'DOLT_PASSWORD', 'DOLT_DATABASE', 'DOLT_TLS_CA_B64', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'];
const ENV_FLAGS = ['--env-file-if-exists=.env', '--env-file-if-exists=.env.local'];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'env-file-scripts-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write `name` in the temp directory, one `KEY=value` line per entry. */
function envFile(name: string, vars: Record<string, string>) {
  writeFileSync(join(dir, name), Object.entries(vars).map(([key, value]) => `${key}=${value}\n`).join(''));
}

/** Run `npm run <name>`'s command in the temp directory, with `shell` already set. */
function runScript(name: string, shell: Record<string, string> = {}, args: string[] = []) {
  const [command, ...rest] = SCRIPTS[name].split(/\s+/);
  expect(command).toBe('node');
  const argv = rest.map((arg) => (arg.startsWith('scripts/') ? join(ROOT, arg) : arg));

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CLEARED) delete env[key];
  return spawnSync(process.execPath, [...argv, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...env, ...shell },
    timeout: 20_000,
  });
}

/** A `file:` url in the temp directory, with forward slashes for the env file. */
function fileUrl(name: string) {
  return `file:${join(dir, name).replace(/\\/g, '/')}`;
}

describe('npm scripts that read env files', { timeout: 30_000 }, () => {
  it.each(['db:migrate', 'db:migrate:libsql', 'db:sweep-runs'])('%s reads .env, then .env.local', (name) => {
    const flags = SCRIPTS[name].split(/\s+/).filter((arg) => arg.startsWith('--env-file'));
    expect(flags).toEqual(ENV_FLAGS);
  });

  it('build:vercel reads no env file, so a build sees only the platform variables', () => {
    expect(SCRIPTS['build:vercel']).not.toContain('--env-file');
  });

  it('db:migrate uses DOLT_* set only in the env files, .env.local over .env', () => {
    envFile('.env', { DOLT_HOST: '127.0.0.1', DOLT_PORT: '2', DOLT_DATABASE: 'from_env' });
    envFile('.env.local', { DOLT_PORT: '1', DOLT_DATABASE: 'from_env_local' });

    const result = runScript('db:migrate');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Migration failed against 127.0.0.1:1/from_env_local');
  });

  it('db:migrate keeps a DOLT_* variable already set in the environment', () => {
    envFile('.env.local', { DOLT_HOST: '127.0.0.1', DOLT_PORT: '1', DOLT_DATABASE: 'from_env_local' });

    const result = runScript('db:migrate', { DOLT_DATABASE: 'from_shell' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Migration failed against 127.0.0.1:1/from_shell');
    expect(result.stderr).not.toContain('from_env_local');
  });

  it('db:migrate:libsql migrates the TURSO_DATABASE_URL set only in .env.local', () => {
    envFile('.env.local', { TURSO_DATABASE_URL: fileUrl('from-env-local.db') });

    const result = runScript('db:migrate:libsql');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('from-env-local.db');
    expect(result.stdout).toContain('table:profiles');
  });

  it('db:migrate:libsql keeps a TURSO_DATABASE_URL already set in the environment', () => {
    envFile('.env.local', { TURSO_DATABASE_URL: fileUrl('from-env-local.db') });

    const result = runScript('db:migrate:libsql', { TURSO_DATABASE_URL: fileUrl('from-shell.db') });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('from-shell.db');
    expect(result.stdout).not.toContain('from-env-local.db');
  });

  it('db:sweep-runs sees DOLT_* set only in .env.local', () => {
    envFile('.env.local', { DOLT_HOST: '127.0.0.1' });

    const result = runScript('db:sweep-runs', {}, ['--dry-run']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Dolt is misconfigured');
    expect(result.stderr).toContain('DOLT_DATABASE is missing');
  });

  it('db:sweep-runs keeps a variable already set in the environment, even an empty one', () => {
    envFile('.env.local', { DOLT_HOST: '127.0.0.1', DOLT_DATABASE: 'from_env_local' });

    const result = runScript('db:sweep-runs', { DOLT_DATABASE: '' }, ['--dry-run']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DOLT_DATABASE is missing');
  });
});
