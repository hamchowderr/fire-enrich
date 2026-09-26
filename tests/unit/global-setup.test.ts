import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';

import { createRunDir, OWNER_FILE, removeStaleRuns } from '../global-setup';

/**
 * The sweep of run directories that earlier test runs left behind. It must
 * never remove the directory of a run that is still going, however long that
 * run has been idle (an open `npm run test:watch`), and must remove the rest.
 */
const HOUR = 60 * 60 * 1000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(inject('tempDir'), 'sweep-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The id of a process that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

function runDirOwnedBy(pid: number): string {
  const dir = mkdtempSync(path.join(root, 'run-'));
  writeFileSync(path.join(dir, OWNER_FILE), String(pid));
  return dir;
}

describe('removeStaleRuns', () => {
  it('keeps a directory whose owner is still running, even long after its last write', () => {
    const dir = runDirOwnedBy(process.pid);

    removeStaleRuns(root, Date.now() + 24 * HOUR);

    expect(existsSync(dir)).toBe(true);
  });

  it('removes a directory whose owner has exited, with the files in it', () => {
    const dir = runDirOwnedBy(deadPid());
    writeFileSync(path.join(dir, 'app.db'), 'x');

    removeStaleRuns(root);

    expect(existsSync(dir)).toBe(false);
  });

  it('removes a directory with no owner file only once it is an hour old', () => {
    const dir = path.join(root, 'run-unowned');
    mkdirSync(dir);

    removeStaleRuns(root);
    expect(existsSync(dir)).toBe(true);

    removeStaleRuns(root, Date.now() + 2 * HOUR);
    expect(existsSync(dir)).toBe(false);
  });

  it('leaves anything that is not a run directory alone', () => {
    const other = path.join(root, 'store-1.db');
    writeFileSync(other, 'x');

    removeStaleRuns(root, Date.now() + 24 * HOUR);

    expect(existsSync(other)).toBe(true);
  });
});

describe('createRunDir', () => {
  it('records this process as the owner, so a concurrent sweep keeps it', () => {
    const dir = createRunDir(root);

    expect(readFileSync(path.join(dir, OWNER_FILE), 'utf8')).toBe(String(process.pid));
    removeStaleRuns(root, Date.now() + 24 * HOUR);
    expect(existsSync(dir)).toBe(true);
  });
});
