import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createClient } from '@libsql/client';

import { resetAppDb } from '@/lib/app-db';

/**
 * A fresh libSQL file per test for the app's tables (profiles, saved plans).
 *
 * `useTempAppDb()` points `TURSO_DATABASE_URL` at a new file in a directory of
 * its own and forgets which databases have their schema, so the next call
 * applies the schema to that file, as it does for any database off Vercel. The returned cleanup
 * closes the client, restores the variable and tries to remove the directory.
 *
 * Profiles and plans need no Dolt, so nothing here sets `DOLT_*`.
 */
export function useTempAppDb(): { url: string; cleanup: () => void } {
  const previous = process.env.TURSO_DATABASE_URL;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fire-enrich-appdb-'));
  const url = `file:${path.join(dir, 'app.db')}`;

  resetAppDb();
  process.env.TURSO_DATABASE_URL = url;

  return {
    url,
    cleanup() {
      resetAppDb();
      process.env.TURSO_DATABASE_URL = previous;
      // Best effort: on Windows the native driver can hold the file a little
      // past close(). Left behind, it sits in the OS temp directory, as the
      // Mastra store file from tests/setup.ts does.
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
