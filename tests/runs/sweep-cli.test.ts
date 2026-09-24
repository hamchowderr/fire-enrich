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

function sweep(...args: string[]) {
  const env = { ...process.env };
  for (const key of ['DOLT_HOST', 'DOLT_PORT', 'DOLT_DATABASE', 'DOLT_USER', 'DOLT_PASSWORD']) delete env[key];
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
}

describe('sweep-runs script', () => {
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

  it('loads lib/runs.ts under plain node and stops at the missing Dolt configuration', () => {
    const result = sweep('--dry-run');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DOLT_HOST and DOLT_DATABASE are not set');
  });
});
