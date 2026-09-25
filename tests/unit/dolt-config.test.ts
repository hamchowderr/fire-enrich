import { describe, expect, it } from 'vitest';

import {
  doltAccessDeniedHint,
  doltConfigState,
  doltMisconfiguredMessage,
  isDoltConfigured,
} from '@/lib/dolt-config.mjs';

/** `lib/dolt-config.mjs`: off, on, and a partial config, from an explicit env. */
describe('doltConfigState', () => {
  it('is off with no connection variable set, including whitespace-only ones', () => {
    expect(doltConfigState({})).toEqual({ state: 'off' });
    expect(doltConfigState({ DOLT_HOST: ' ', DOLT_PASSWORD: '' })).toEqual({ state: 'off' });
    expect(doltConfigState({ DOLT_COMMIT_AUTHOR: 'A <a@example.com>', DOLT_PREVIEW_MIGRATE: '1' })).toEqual({ state: 'off' });
    expect(isDoltConfigured({})).toBe(false);
  });

  it('is on with DOLT_HOST and DOLT_DATABASE, an empty password included', () => {
    const env = { DOLT_HOST: '127.0.0.1', DOLT_DATABASE: 'fire_enrich', DOLT_PASSWORD: '' };

    expect(doltConfigState(env)).toEqual({ state: 'on' });
    expect(isDoltConfigured(env)).toBe(true);
  });

  it.each([
    [{ DOLT_HOST: 'h' }, ['DOLT_DATABASE'], ['DOLT_HOST']],
    [{ DOLT_DATABASE: 'd' }, ['DOLT_HOST'], ['DOLT_DATABASE']],
    [{ DOLT_HOST: 'h', DOLT_PASSWORD: 'p' }, ['DOLT_DATABASE'], ['DOLT_HOST', 'DOLT_PASSWORD']],
    [{ DOLT_PORT: '3306' }, ['DOLT_HOST', 'DOLT_DATABASE'], ['DOLT_PORT']],
    [{ DOLT_HOST: 'h', DOLT_DATABASE: '  ' }, ['DOLT_DATABASE'], ['DOLT_HOST']],
  ])('is misconfigured for %j', (env, missing, set) => {
    expect(doltConfigState(env)).toEqual({ state: 'misconfigured', missing, set });
    expect(isDoltConfigured(env)).toBe(false);
  });

  it('names what is set and what is missing, never a value', () => {
    const message = doltMisconfiguredMessage({ missing: ['DOLT_DATABASE'], set: ['DOLT_HOST', 'DOLT_PASSWORD'] });

    expect(message).toBe(
      'Dolt is misconfigured: DOLT_HOST, DOLT_PASSWORD are set but DOLT_DATABASE is missing. ' +
        'Set DOLT_HOST and DOLT_DATABASE to enable Dolt, or unset every DOLT_* connection variable to run without it.'
    );
  });
});

describe('doltAccessDeniedHint', () => {
  const denied = new Error("Access denied for user 'root'@'10.0.0.1' (using password: NO)");

  it('points at DOLT_PASSWORD when access is denied and no password is set', () => {
    expect(doltAccessDeniedHint(denied, { DOLT_PASSWORD: '' })).toContain('DOLT_PASSWORD is empty or unset');
    expect(doltAccessDeniedHint(denied, {})).toContain('DOLT_PASSWORD');
  });

  it('adds nothing when a password is set or the error is something else', () => {
    expect(doltAccessDeniedHint(denied, { DOLT_PASSWORD: 'secret' })).toBe('');
    expect(doltAccessDeniedHint(new Error('connect ECONNREFUSED'), {})).toBe('');
  });
});
