import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';

import { createClient } from '@libsql/client';
import { inject } from 'vitest';

import { resetAppDb } from '@/lib/app-db';

/**
 * The test timeout for tests that each use {@link useTempAppDb}. Every such
 * test creates a database file, applies the schema and writes to it, so it
 * waits on the disk. That takes about 1 s at most on a quiet machine. With four
 * full suites running at once, one test took 7.5 s, past Vitest's 5 s default.
 */
export const TEMP_APP_DB_TIMEOUT = 15_000;

/**
 * A fresh libSQL file per test for the app's tables (profiles, saved plans).
 *
 * `useTempAppDb()` points `TURSO_DATABASE_URL` at a new file in a directory of
 * its own, inside the run's temporary directory (`tests/global-setup.ts`), and forgets which databases have their schema, so the next call
 * applies the schema to that file, as it does for any database off Vercel. The returned cleanup
 * closes the client, restores the variable and tries to remove the directory.
 *
 * Profiles and plans need no Dolt, so nothing here sets `DOLT_*`.
 */
export function useTempAppDb(): { url: string; cleanup: () => void } {
  const previous = process.env.TURSO_DATABASE_URL;
  const dir = mkdtempSync(path.join(inject('tempDir'), 'appdb-'));
  const url = `file:${path.join(dir, 'app.db')}`;

  resetAppDb();
  process.env.TURSO_DATABASE_URL = url;

  return {
    url,
    cleanup() {
      resetAppDb();
      process.env.TURSO_DATABASE_URL = previous;
      // Best effort: on Windows the native driver holds the file until the
      // client is garbage collected. The global teardown removes what is left.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignored
      }
    },
  };
}

/**
 * Hold the database's write lock from a second client, as another request or
 * process would, until `release` is called. Writes made through `execute`
 * land when the holder commits on release.
 */
export async function holdWriteLock(url: string) {
  const other = createClient({ url });
  const transaction = await other.transaction('write');

  return {
    async execute(sql: string, args: Array<string | null> = []) {
      await transaction.execute({ sql, args });
    },
    async release() {
      await transaction.commit();
      transaction.close();
      other.close();
    },
  };
}
