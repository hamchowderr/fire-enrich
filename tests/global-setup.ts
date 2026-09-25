/**
 * Vitest global setup (see `vitest.config.mts`): one temporary directory per
 * test run, for every database file the tests create, removed when the run
 * ends.
 *
 * A test cannot remove its own libSQL file on Windows: the local-file driver
 * keeps the native handle open after `close()` until the garbage collector
 * reclaims the client (see `lib/app-db.ts`). So each test used to leave its
 * directory in the OS temp directory, and every run added more. This
 * teardown runs after the tests, when the workers are closing.
 *
 * Each run has a directory of its own, so two runs on one machine never
 * remove each other's files. On Windows a file can stay locked for a moment
 * after its process exits. When the teardown cannot remove the directory, it
 * says so and does not fail the run, and a later run removes it: at start,
 * each run removes the run directories that nothing has written to for an
 * hour.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** This run's temporary directory. Read it with `inject('tempDir')`. */
    tempDir: string;
  }
}

const STALE_AFTER_MS = 60 * 60 * 1000;

function remove(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

/** Remove the run directories that earlier runs could not remove. */
function removeStaleRuns(root: string) {
  for (const name of readdirSync(root)) {
    if (!name.startsWith('run-')) continue;
    const dir = path.join(root, name);
    try {
      if (Date.now() - statSync(dir).mtimeMs > STALE_AFTER_MS) remove(dir);
    } catch {
      // Removed by another run in the meantime.
    }
  }
}

export default function setup(project: TestProject) {
  const root = path.join(os.tmpdir(), 'fire-enrich-tests');
  mkdirSync(root, { recursive: true });
  removeStaleRuns(root);

  const tempDir = mkdtempSync(path.join(root, 'run-'));
  project.provide('tempDir', tempDir);

  return () => {
    if (!remove(tempDir)) {
      console.warn(`[tests] Could not remove ${tempDir} yet; a later run removes it.`);
    }
  };
}
