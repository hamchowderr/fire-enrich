import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as MastraModule from '@/lib/mastra/index';

/**
 * The storage choice in `lib/mastra/index.ts`: Turso when `TURSO_DATABASE_URL`
 * is set, a local SQLite file otherwise, and one clear error where that file
 * cannot be written (Vercel, or any read-only filesystem).
 *
 * The module builds its Mastra instance at import and caches it on
 * `globalThis`, so every test clears that cache and imports a fresh copy of the
 * module, or the cached instance would hide the path under test. `node:fs` is
 * wrapped so each test can see (or fail) the filesystem calls the module makes,
 * and `LibSQLStore` is wrapped to record the url it is given.
 *
 * Only `lib/mastra/index` itself is re-evaluated (a distinct query string per
 * import gives a new module instance); its agent and workflow imports stay
 * cached after the warm-up in `beforeAll`, which pays their cold load once.
 */

const WARM_UP_TIMEOUT = 120_000;

const ENV_KEYS = ['VERCEL', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

const globalForMastra = globalThis as typeof globalThis & { __fireEnrichMastra?: unknown };

const fsCalls = { mkdirSync: vi.fn(), existsSync: vi.fn() };
let mkdirFailure: NodeJS.ErrnoException | undefined;
const storeUrls: string[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const mkdirSync: typeof actual.mkdirSync = (...args: Parameters<typeof actual.mkdirSync>) => {
    fsCalls.mkdirSync(...args);
    if (mkdirFailure) throw mkdirFailure;
    return actual.mkdirSync(...args);
  };
  const existsSync: typeof actual.existsSync = (target) => {
    fsCalls.existsSync(target);
    return actual.existsSync(target);
  };
  const wrapped = { ...actual, mkdirSync, existsSync };
  return { ...wrapped, default: wrapped };
});

vi.mock('@mastra/libsql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mastra/libsql')>();
  class RecordingLibSQLStore extends actual.LibSQLStore {
    constructor(config: ConstructorParameters<typeof actual.LibSQLStore>[0]) {
      if ('url' in config) storeUrls.push(config.url);
      // Record the url, then open an in-memory database in its place, so no
      // test holds a file handle (which on Windows blocks the temp cleanup).
      super('url' in config ? { ...config, url: ':memory:', authToken: undefined } : config);
    }
  }
  return { ...actual, LibSQLStore: RecordingLibSQLStore };
});

const MODULE_URL = new URL('../../lib/mastra/index.ts', import.meta.url).href;
let importCount = 0;

/** A freshly evaluated `lib/mastra/index`, as though the module cache were cleared. */
function importMastra(): Promise<typeof MastraModule> {
  importCount += 1;
  return import(/* @vite-ignore */ `${MODULE_URL}?case=${importCount}`);
}

/** What a read-only filesystem such as Vercel's `/var/task` throws from mkdir. */
function mkdirError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: mkdir '/var/task/.mastra'`), { code });
}

const SERVERLESS_MESSAGE = /^TURSO_DATABASE_URL \(and TURSO_AUTH_TOKEN\) is required on serverless/;

let tempRoot: string | undefined;

/** Point `projectRoot()` at a throwaway directory holding a `package.json`. */
function useTempProjectRoot(): string {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), 'fire-enrich-store-'));
  writeFileSync(path.join(tempRoot, 'package.json'), '{}');
  vi.spyOn(process, 'cwd').mockReturnValue(tempRoot);
  return tempRoot;
}

beforeAll(async () => {
  const turso = process.env.TURSO_DATABASE_URL;
  process.env.TURSO_DATABASE_URL = 'libsql://fire-enrich-test.turso.io';
  delete globalForMastra.__fireEnrichMastra;
  try {
    await importMastra();
  } finally {
    if (turso === undefined) delete process.env.TURSO_DATABASE_URL;
    else process.env.TURSO_DATABASE_URL = turso;
    delete globalForMastra.__fireEnrichMastra;
  }
}, WARM_UP_TIMEOUT);

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  delete globalForMastra.__fireEnrichMastra;
  fsCalls.mkdirSync.mockClear();
  fsCalls.existsSync.mockClear();
  mkdirFailure = undefined;
  storeUrls.length = 0;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  delete globalForMastra.__fireEnrichMastra;
  vi.restoreAllMocks();
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe('Mastra storage on serverless without Turso', () => {
  it('throws one error naming TURSO_DATABASE_URL before touching the filesystem', async () => {
    process.env.VERCEL = '1';
    delete process.env.TURSO_DATABASE_URL;
    delete process.env.TURSO_AUTH_TOKEN;

    await expect(importMastra()).rejects.toThrow(SERVERLESS_MESSAGE);
    expect(fsCalls.mkdirSync).not.toHaveBeenCalled();
    expect(storeUrls).toEqual([]);
    expect(globalForMastra.__fireEnrichMastra).toBeUndefined();
  });

  it.each(['EROFS', 'EACCES'])(
    'reports a %s from mkdirSync with the same message, not the raw error',
    async (code) => {
      delete process.env.VERCEL;
      delete process.env.TURSO_DATABASE_URL;
      useTempProjectRoot();
      mkdirFailure = mkdirError(code);

      const error: unknown = await importMastra().then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(SERVERLESS_MESSAGE);
      expect((error as Error).message).not.toContain(code);
      expect((error as Error).cause).toBe(mkdirFailure);
      expect(storeUrls).toEqual([]);
    },
  );

  it('rethrows any other mkdirSync failure unchanged', async () => {
    delete process.env.VERCEL;
    delete process.env.TURSO_DATABASE_URL;
    useTempProjectRoot();
    mkdirFailure = mkdirError('ENOSPC');

    await expect(importMastra()).rejects.toBe(mkdirFailure);
  });
});

describe('Mastra storage with Turso configured', () => {
  it.each([
    ['on Vercel', '1'],
    ['locally', undefined],
  ])('uses the Turso url with no filesystem call %s', async (_label, vercel) => {
    if (vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = vercel;
    process.env.TURSO_DATABASE_URL = 'libsql://fire-enrich-test.turso.io';
    process.env.TURSO_AUTH_TOKEN = 'stub';

    const { mastra } = await importMastra();

    expect(mastra).toBeDefined();
    expect(storeUrls).toEqual(['libsql://fire-enrich-test.turso.io']);
    expect(fsCalls.mkdirSync).not.toHaveBeenCalled();
    expect(fsCalls.existsSync).not.toHaveBeenCalled();
  });
});

describe('Mastra storage locally without Turso', () => {
  it('creates and uses .mastra/fire-enrich.db under the project root', async () => {
    delete process.env.VERCEL;
    delete process.env.TURSO_DATABASE_URL;
    const root = useTempProjectRoot();
    const file = path.join(root, '.mastra', 'fire-enrich.db');

    const { mastra } = await importMastra();

    expect(mastra).toBeDefined();
    expect(storeUrls).toEqual([`file:${file}`]);
    expect(existsSync(path.dirname(file))).toBe(true);
  });
});
