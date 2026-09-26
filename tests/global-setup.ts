/**
 * Vitest global setup (see `vitest.config.mts`): one temporary directory per
 * test run, for every database file the tests create, removed when the run
 * ends.
 *
 * A test cannot remove its own libSQL file on Windows: the local-file driver
 * keeps the native handle open after `close()` until the garbage collector
 * reclaims the client (see `lib/app-db.ts`). So each test used to leave its
 * directory in the OS temp directory, and every run added more.
 *
 * The teardown below removes the run's directory. In Vitest 5.0.1 it runs
 * before the worker pool closes, so a worker can still hold a libSQL handle
 * at that point, and on Windows the removal often fails. The teardown then
 * warns and does not fail the run. The next run removes the directory: at
 * start, each run removes every run directory whose owner process has
 * exited (see {@link removeStaleRuns}).
 *
 * Each run has a directory of its own, so two runs on one machine never
 * remove each other's files, and a run never removes the directory of one
 * that is still going, such as an idle `npm run test:watch`.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** This run's temporary directory. Read it with `inject('tempDir')`. */
    tempDir: string;
  }
}

/** The file in a run directory that names the process that owns it. */
export const OWNER_FILE = 'owner.pid';

/** How old a run directory with no owner file must be before it is removed. */
const UNOWNED_STALE_AFTER_MS = 60 * 60 * 1000;

function remove(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

/** Whether a process with this id is running. `EPERM` means it runs as another user. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The owner's process id, or undefined when the directory has no readable owner file. */
function ownerOf(dir: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path.join(dir, OWNER_FILE), 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create a run directory under `root`, owned by this process.
 *
 * @public Exported for tests/unit/global-setup.test.ts.
 */
export function createRunDir(root: string): string {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, 'run-'));
  writeFileSync(path.join(dir, OWNER_FILE), String(process.pid));
  return dir;
}

/**
 * Remove the run directories under `root` that earlier runs could not remove.
 * A directory whose owner process is still running is kept, however long it
 * has been idle. A directory with no owner file is removed once it is an hour
 * old.
 *
 * @public Exported for tests/unit/global-setup.test.ts.
 */
export function removeStaleRuns(root: string, now = Date.now()): void {
  for (const name of readdirSync(root)) {
    if (!name.startsWith('run-')) continue;
    const dir = path.join(root, name);
    const owner = ownerOf(dir);
    if (owner !== undefined) {
      if (!isAlive(owner)) remove(dir);
      continue;
    }
    try {
      if (now - statSync(dir).mtimeMs > UNOWNED_STALE_AFTER_MS) remove(dir);
    } catch {
      // Removed by another run in the meantime.
    }
  }
}

export default function setup(project: TestProject) {
  const root = path.join(os.tmpdir(), 'fire-enrich-tests');
  mkdirSync(root, { recursive: true });
  removeStaleRuns(root);

  const tempDir = createRunDir(root);
  project.provide('tempDir', tempDir);

  return () => {
    if (!remove(tempDir)) {
      console.warn(`[tests] Could not remove ${tempDir} yet; the next run removes it.`);
    }
  };
}
