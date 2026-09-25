/**
 * Vitest global setup (see `vitest.config.mts`): one temporary directory per
 * test run, for every database file the tests create, removed when the run
 * ends.
 *
 * A test cannot remove its own libSQL file on Windows: the local-file driver
 * keeps the native handle open after `close()` until the garbage collector
 * reclaims the client (see `lib/app-db.ts`). So each test used to leave its
 * directory in the OS temp directory, and every run added more. This
 * teardown runs after the test workers have exited, when no handle is open.
 *
 * Each run has a directory of its own, so two runs on one machine never
 * remove each other's files.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** This run's temporary directory. Read it with `inject('tempDir')`. */
    tempDir: string;
  }
}

export default function setup(project: TestProject) {
  const root = path.join(os.tmpdir(), 'fire-enrich-tests');
  mkdirSync(root, { recursive: true });
  const tempDir = mkdtempSync(path.join(root, 'run-'));
  project.provide('tempDir', tempDir);

  return () => {
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
}
