import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `scripts/sweep-runs.mjs` argument handling, run as the real script in a
 * child process. Every case here exits before the script loads `lib/runs.ts`
 * or opens a connection, and the Dolt variables are cleared, so no database is
 * involved.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/sweep-runs.mjs', import.meta.url));
const USAGE = 'Usage: npm run db:sweep-runs -- [--older-than-hours <hours>] [--dry-run]';

const DOLT_ENV = ['DOLT_HOST', 'DOLT_PORT', 'DOLT_DATABASE', 'DOLT_USER', 'DOLT_PASSWORD', 'DOLT_TLS_CA_B64'];

/** Run the script with every Dolt variable cleared, then `extra` set. */
function sweepWith(extra: Record<string, string>, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of DOLT_ENV) delete env[key];
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...env, ...extra } });
}

function sweep(...args: string[]) {
  return sweepWith({}, args);
}

// Each case starts a Node process; under a full parallel suite that can take
// longer than vitest's 5 s default.
describe('sweep-runs script', { timeout: 30_000 }, () => {
  it('prints the usage line and exits 2 on an unknown flag, without a stack trace', () => {
    const result = sweep('--port', '3306');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown option '--port'");
    expect(result.stderr).toContain(USAGE);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it('exits 2 on a threshold that is not a positive number', () => {
    const result = sweep('--older-than-hours', 'abc');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--older-than-hours must be a positive number, not abc');
    expect(result.stderr).toContain(USAGE);
  });

  it('prints the usage line and exits 0 on --help', () => {
    const result = sweep('--help');

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(USAGE);
  });

  it('loads lib/runs.ts under plain node and, with no Dolt configured, says it requires Dolt and exits 0', () => {
    const result = sweep('--dry-run');

    // Dolt is optional: no Dolt means no recorded runs, so nothing to sweep.
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('db:sweep-runs requires Dolt, which is not configured');
    expect(result.stdout).toContain('DOLT_HOST and DOLT_DATABASE');
    expect(result.stderr).toBe('');
  });

  it.each([
    ['DOLT_HOST only', { DOLT_HOST: '127.0.0.1' }, 'DOLT_DATABASE is missing'],
    ['DOLT_DATABASE only', { DOLT_DATABASE: 'fire_enrich' }, 'DOLT_HOST is missing'],
    ['DOLT_HOST and DOLT_PASSWORD', { DOLT_HOST: '127.0.0.1', DOLT_PASSWORD: 'pw' }, 'DOLT_DATABASE is missing'],
    ['DOLT_USER only', { DOLT_USER: 'app' }, 'DOLT_HOST and DOLT_DATABASE are missing'],
    ['a whitespace-only DOLT_DATABASE', { DOLT_HOST: '127.0.0.1', DOLT_DATABASE: '  ' }, 'DOLT_DATABASE is missing'],
  ])('exits 1 on a partial Dolt (%s), naming what is missing', (_label, dolt, missing) => {
    const result = sweepWith(dolt, ['--dry-run']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Dolt is misconfigured');
    expect(result.stderr).toContain(missing);
    expect(result.stdout).toBe('');
  });
});
