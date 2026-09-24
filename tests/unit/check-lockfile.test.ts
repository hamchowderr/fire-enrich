import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { lockfileProblems } from '@/scripts/check-lockfile.mjs';

const SWC = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'linux-x64-gnu',
  'linux-x64-musl',
  'win32-arm64-msvc',
  'win32-x64-msvc',
].map((platform) => `@next/swc-${platform}`);

/** A minimal lockfile whose next@15.3.9 declares every SWC binary at 15.3.5. */
function lockfile(swcAt: (name: string) => Record<string, { version: string }> = (name) => ({
  [`node_modules/${name}`]: { version: '15.3.5' },
})) {
  const packages: Record<string, { version?: string; optionalDependencies?: Record<string, string> }> = {
    '': {},
    'node_modules/next': {
      version: '15.3.9',
      optionalDependencies: { ...Object.fromEntries(SWC.map((name) => [name, '15.3.5'])), sharp: '^0.34.1' },
    },
  };
  for (const name of SWC) Object.assign(packages, swcAt(name));
  return { lockfileVersion: 3, packages };
}

describe('lockfileProblems', () => {
  it('passes the committed package-lock.json', () => {
    const path = fileURLToPath(new URL('../../package-lock.json', import.meta.url));
    expect(lockfileProblems(JSON.parse(readFileSync(path, 'utf8')))).toEqual([]);
  });

  it('passes when every SWC binary is at the top level with the declared version', () => {
    expect(lockfileProblems(lockfile())).toEqual([]);
  });

  it('reports the binaries a Mac-only install left out', () => {
    const lock = lockfile((name) =>
      name === '@next/swc-darwin-arm64' ? { [`node_modules/${name}`]: { version: '15.3.5' } } : {},
    );
    const problems = lockfileProblems(lock);
    expect(problems).toHaveLength(7);
    expect(problems[0]).toContain('@next/swc-darwin-x64@15.3.5 is missing');
  });

  it('reports a binary locked at a different version than next declares', () => {
    const lock = lockfile((name) => ({ [`node_modules/${name}`]: { version: name.endsWith('win32-x64-msvc') ? '15.3.2' : '15.3.5' } }));
    expect(lockfileProblems(lock)).toEqual([
      '@next/swc-win32-x64-msvc is locked at 15.3.2, but next@15.3.9 requires 15.3.5.',
    ]);
  });

  it('reports binaries nested under next, even when top-level copies exist', () => {
    // The upstream lockfile: npm resolves next to the nested copies and prunes
    // the top-level ones Next's patcher adds, so the two keep undoing each other.
    const lock = lockfile((name) => ({
      [`node_modules/${name}`]: { version: '15.3.5' },
      ...(name === '@next/swc-darwin-arm64' ? {} : { [`node_modules/next/node_modules/${name}`]: { version: '15.3.5' } }),
    }));
    const problems = lockfileProblems(lock);
    expect(problems).toHaveLength(7);
    expect(problems.every((problem) => problem.includes('is nested under next'))).toBe(true);
  });

  it('reports a lockfile without next or without a packages map', () => {
    expect(lockfileProblems({ lockfileVersion: 1 })).toHaveLength(1);
    expect(lockfileProblems({ lockfileVersion: 3, packages: { '': {} } })).toEqual([
      'package-lock.json has no "node_modules/next" entry.',
    ]);
  });
});
