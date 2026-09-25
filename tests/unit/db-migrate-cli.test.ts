import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `scripts/db-migrate.mjs` run as the real script, for its two failure exits.
 * The Vercel build only calls it when Dolt is configured (`migrationPlan`), so
 * what matters here is that a configured migration that fails still fails
 * the build, and that a hand run with nothing configured says why.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/db-migrate.mjs', import.meta.url));
const DOLT_ENV = ['DOLT_HOST', 'DOLT_PORT', 'DOLT_USER', 'DOLT_PASSWORD', 'DOLT_DATABASE', 'DOLT_TLS_CA_B64'];

function migrate(extra: Record<string, string>) {
  const env = { ...process.env };
  for (const key of DOLT_ENV) delete env[key];
  return spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...env, ...extra }, timeout: 20_000 });
}

describe('db-migrate script', { timeout: 30_000 }, () => {
  it('exits 1 naming the variables when run by hand with no Dolt configured', () => {
    const result = migrate({});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Dolt is not configured: set DOLT_HOST and DOLT_DATABASE');
  });

  it('exits 1 when Dolt is configured but the migration cannot run, so the build fails', () => {
    // Port 1 on loopback: nothing listens, the connection is refused at once.
    const result = migrate({ DOLT_HOST: '127.0.0.1', DOLT_PORT: '1', DOLT_DATABASE: 'fire_enrich' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Migration failed against 127.0.0.1:1/fire_enrich');
  });
});
