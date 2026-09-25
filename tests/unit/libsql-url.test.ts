import { describe, expect, it } from 'vitest';

import { libsqlConnection, tursoConfig } from '@/lib/libsql-url.mjs';

/**
 * The Turso variable names `lib/libsql-url.mjs` accepts. The Vercel Marketplace
 * Turso integration sets TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, or, when the
 * project is connected with a custom prefix, `<PREFIX>_TURSO_DATABASE_URL` and
 * `<PREFIX>_TURSO_AUTH_TOKEN`. A url is only ever paired with the token of its
 * own naming. No database is opened: every env here names a remote url, so the
 * local file fallback is never reached except where a test says so.
 */
const URL_A = 'libsql://a.turso.io';
const URL_B = 'libsql://b.turso.io';

describe('tursoConfig', () => {
  it('reads the plain pair', () => {
    expect(tursoConfig({ TURSO_DATABASE_URL: URL_A, TURSO_AUTH_TOKEN: 'tok-a' })).toEqual({
      state: 'on',
      url: URL_A,
      authToken: 'tok-a',
      urlVar: 'TURSO_DATABASE_URL',
      tokenVar: 'TURSO_AUTH_TOKEN',
    });
  });

  it('accepts the plain url without a token (a file or a local server)', () => {
    expect(tursoConfig({ TURSO_DATABASE_URL: 'file:./x.db' })).toMatchObject({ state: 'on', url: 'file:./x.db', authToken: undefined });
  });

  it('reads a prefixed pair, the Marketplace integration connected with a custom prefix', () => {
    expect(tursoConfig({ FIRE_TURSO_DATABASE_URL: URL_B, FIRE_TURSO_AUTH_TOKEN: 'tok-b' })).toEqual({
      state: 'on',
      url: URL_B,
      authToken: 'tok-b',
      urlVar: 'FIRE_TURSO_DATABASE_URL',
      tokenVar: 'FIRE_TURSO_AUTH_TOKEN',
    });
    // Vercel allows lower-case letters in a prefix.
    expect(tursoConfig({ fireenrich_TURSO_DATABASE_URL: URL_B, fireenrich_TURSO_AUTH_TOKEN: 'tok-b' })).toMatchObject({
      state: 'on',
      url: URL_B,
    });
  });

  it('prefers the plain url over a prefixed pair, and never borrows the prefixed token', () => {
    const config = tursoConfig({
      TURSO_DATABASE_URL: URL_A,
      FIRE_TURSO_DATABASE_URL: URL_B,
      FIRE_TURSO_AUTH_TOKEN: 'tok-b',
    });

    expect(config).toMatchObject({ state: 'on', url: URL_A, authToken: undefined, urlVar: 'TURSO_DATABASE_URL' });
  });

  it('reports a mixed or half pair as misconfigured, naming what is set and what is missing', () => {
    const cases: [Record<string, string>, string[], string[]][] = [
      // A prefixed url with the plain token.
      [{ FIRE_TURSO_DATABASE_URL: URL_B, TURSO_AUTH_TOKEN: 'tok-a' }, ['FIRE_TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'], ['FIRE_TURSO_AUTH_TOKEN', 'TURSO_DATABASE_URL']],
      // A url and a token under two different prefixes.
      [{ A_TURSO_DATABASE_URL: URL_A, B_TURSO_AUTH_TOKEN: 'tok-b' }, ['A_TURSO_DATABASE_URL', 'B_TURSO_AUTH_TOKEN'], ['A_TURSO_AUTH_TOKEN', 'B_TURSO_DATABASE_URL']],
      // A prefixed url alone.
      [{ FIRE_TURSO_DATABASE_URL: URL_B }, ['FIRE_TURSO_DATABASE_URL'], ['FIRE_TURSO_AUTH_TOKEN']],
      // A prefixed token alone.
      [{ FIRE_TURSO_AUTH_TOKEN: 'tok-b' }, ['FIRE_TURSO_AUTH_TOKEN'], ['FIRE_TURSO_DATABASE_URL']],
      // The plain token alone.
      [{ TURSO_AUTH_TOKEN: 'tok-a' }, ['TURSO_AUTH_TOKEN'], ['TURSO_DATABASE_URL']],
    ];
    for (const [env, set, missing] of cases) {
      expect(tursoConfig(env)).toEqual({ state: 'misconfigured', set, missing });
    }
  });

  it('reports off when no Turso variable is set', () => {
    expect(tursoConfig({})).toEqual({ state: 'off' });
    expect(tursoConfig({ SOMETHING_ELSE: 'x' })).toEqual({ state: 'off' });
  });

  it('treats an empty or whitespace value as unset', () => {
    expect(tursoConfig({ TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: '' })).toEqual({ state: 'off' });
    expect(tursoConfig({ TURSO_DATABASE_URL: '  ' })).toEqual({ state: 'off' });
    expect(tursoConfig({ FIRE_TURSO_DATABASE_URL: ' ', FIRE_TURSO_AUTH_TOKEN: '' })).toEqual({ state: 'off' });
    expect(tursoConfig({ TURSO_DATABASE_URL: '', TURSO_AUTH_TOKEN: 'tok' })).toMatchObject({ state: 'misconfigured' });
    expect(tursoConfig({ FIRE_TURSO_DATABASE_URL: URL_B, FIRE_TURSO_AUTH_TOKEN: ' ' })).toMatchObject({
      state: 'misconfigured',
      missing: ['FIRE_TURSO_AUTH_TOKEN'],
    });
    expect(tursoConfig({ TURSO_DATABASE_URL: URL_A, TURSO_AUTH_TOKEN: '' })).toMatchObject({ url: URL_A, authToken: undefined });
  });

  it('reports two complete prefixed pairs as ambiguous, naming the variables only', () => {
    const config = tursoConfig({
      B_TURSO_DATABASE_URL: URL_B,
      B_TURSO_AUTH_TOKEN: 'tok-b',
      A_TURSO_DATABASE_URL: URL_A,
      A_TURSO_AUTH_TOKEN: 'tok-a',
    });

    expect(config).toEqual({ state: 'ambiguous', urlVars: ['A_TURSO_DATABASE_URL', 'B_TURSO_DATABASE_URL'] });
  });

  it('is not ambiguous when only one prefixed pair is complete', () => {
    const config = tursoConfig({
      A_TURSO_DATABASE_URL: URL_A,
      A_TURSO_AUTH_TOKEN: 'tok-a',
      B_TURSO_DATABASE_URL: URL_B,
    });

    expect(config).toMatchObject({ state: 'on', url: URL_A, authToken: 'tok-a' });
  });

  it('does not treat the plain name as a prefix of itself', () => {
    expect(tursoConfig({ _TURSO_DATABASE_URL: URL_B, _TURSO_AUTH_TOKEN: 'tok-b' })).toEqual({ state: 'off' });
  });
});

describe('libsqlConnection', () => {
  it('opens the prefixed pair', () => {
    expect(libsqlConnection({ FIRE_TURSO_DATABASE_URL: URL_B, FIRE_TURSO_AUTH_TOKEN: 'tok-b' })).toEqual({
      url: URL_B,
      authToken: 'tok-b',
    });
  });

  it('throws on a partial pair, naming the variables and no value', () => {
    const env = { FIRE_TURSO_DATABASE_URL: URL_B };

    expect(() => libsqlConnection(env)).toThrow(
      'Turso is misconfigured: FIRE_TURSO_DATABASE_URL is set but FIRE_TURSO_AUTH_TOKEN is missing.'
    );
    expect(() => libsqlConnection(env)).not.toThrow(URL_B);
  });

  it('throws on ambiguous variables, naming them and no value', () => {
    const env = {
      A_TURSO_DATABASE_URL: URL_A,
      A_TURSO_AUTH_TOKEN: 'tok-a',
      B_TURSO_DATABASE_URL: URL_B,
      B_TURSO_AUTH_TOKEN: 'tok-b',
    };

    expect(() => libsqlConnection(env)).toThrow(/A_TURSO_DATABASE_URL, B_TURSO_DATABASE_URL/);
    try {
      libsqlConnection(env);
    } catch (error) {
      const message = (error as Error).message;
      for (const value of [URL_A, URL_B, 'tok-a', 'tok-b']) expect(message).not.toContain(value);
    }
  });
});
