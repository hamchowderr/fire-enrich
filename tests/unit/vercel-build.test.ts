import { describe, expect, it } from 'vitest';

import { migrationPlan } from '@/scripts/vercel-build.mjs';

/** Which Vercel builds apply `db/schema.sql`. No build or database is involved. */
const DOLT = { DOLT_HOST: 'dolt.example', DOLT_DATABASE: 'fire_enrich' };

describe('migrationPlan', () => {
  it('migrates a production build that has a Dolt database', () => {
    expect(migrationPlan({ VERCEL_ENV: 'production', ...DOLT }).migrate).toBe(true);
  });

  it('skips a production build with no Dolt database', () => {
    const plan = migrationPlan({ VERCEL_ENV: 'production', DOLT_HOST: 'dolt.example' });

    expect(plan.migrate).toBe(false);
    expect(plan.reason).toContain('DOLT_DATABASE');
  });

  it('skips every build with no DOLT_* at all, and says Dolt is optional', () => {
    for (const env of [
      { VERCEL_ENV: 'production' },
      { VERCEL_ENV: 'preview', DOLT_PREVIEW_MIGRATE: '1' },
      { VERCEL_ENV: 'development' },
      {},
    ]) {
      const plan = migrationPlan(env);
      expect(plan.migrate).toBe(false);
      expect(plan.reason).toBe('Dolt is not configured (optional; set DOLT_HOST and DOLT_DATABASE to enable it)');
    }
  });

  it('counts an empty DOLT_HOST or DOLT_DATABASE as not configured', () => {
    expect(migrationPlan({ VERCEL_ENV: 'production', DOLT_HOST: '', DOLT_DATABASE: 'fire_enrich' }).migrate).toBe(false);
    expect(migrationPlan({ VERCEL_ENV: 'production', DOLT_HOST: 'dolt.example', DOLT_DATABASE: '' }).migrate).toBe(false);
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
