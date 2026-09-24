#!/usr/bin/env node
/**
 * Fail when package-lock.json does not record Next's SWC binaries where
 * `next build` and `next lint` look for them.
 *
 *   npm run check:lockfile            # checks ./package-lock.json
 *   node scripts/check-lockfile.mjs path/to/package-lock.json
 *
 * On every local run, Next (node_modules/next/dist/lib/patch-incorrect-lockfile.js)
 * reads its own `optionalDependencies`. If any `@next/swc-*` package in that
 * list has no entry at `node_modules/@next/swc-*` in package-lock.json, Next
 * downloads registry metadata and rewrites the whole lockfile. It skips this
 * when it detects CI, so CI never sees the problem. This check makes it fail
 * in CI instead.
 *
 * Each locked `@next/swc-*` binary must:
 *
 *   1. have an entry at the top level (`node_modules/@next/swc-*`), because
 *      that is the only place Next's patcher looks, and
 *   2. have the exact version that the locked `next` declares, and
 *   3. not have a second copy nested under `node_modules/next/node_modules/`.
 *      A nested copy is the one `next` resolves to, so npm treats the top-level
 *      copy as extraneous and deletes it on the next `npm install`. Next then
 *      adds it back on the next build. The upstream lockfile was in this state.
 *
 * Plain `.mjs` with no dependencies, so it needs nothing installed or built.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SWC_PREFIX = '@next/swc-';

/**
 * List what is wrong with a parsed package-lock.json. An empty list means
 * Next's lockfile patcher has nothing to add and npm has nothing to prune.
 *
 * @param {{ lockfileVersion?: number, packages?: Record<string, { version?: string, optionalDependencies?: Record<string, string> }> }} lock
 * @returns {string[]}
 */
export function lockfileProblems(lock) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object') {
    return ['package-lock.json has no "packages" map (lockfileVersion 2 or 3 is required).'];
  }

  const next = packages['node_modules/next'];
  if (!next) {
    return ['package-lock.json has no "node_modules/next" entry.'];
  }

  const expected = Object.entries(next.optionalDependencies ?? {}).filter(([name]) => name.startsWith(SWC_PREFIX));
  if (expected.length === 0) {
    return [`The locked next@${next.version} lists no ${SWC_PREFIX}* optionalDependencies.`];
  }

  const problems = [];
  for (const [name, version] of expected) {
    const entry = packages[`node_modules/${name}`];
    if (!entry) {
      problems.push(`${name}@${version} is missing at node_modules/${name}.`);
    } else if (entry.version !== version) {
      problems.push(`${name} is locked at ${entry.version}, but next@${next.version} requires ${version}.`);
    }
  }

  const nestedPrefix = `node_modules/next/node_modules/${SWC_PREFIX}`;
  for (const key of Object.keys(packages)) {
    if (key.startsWith(nestedPrefix)) {
      problems.push(`${key} is nested under next; npm will prune the top-level copy that Next checks for.`);
    }
  }

  return problems;
}

function main() {
  const path = process.argv[2] ?? fileURLToPath(new URL('../package-lock.json', import.meta.url));
  const problems = lockfileProblems(JSON.parse(readFileSync(path, 'utf8')));

  if (problems.length === 0) {
    console.log('package-lock.json records every @next/swc-* binary that next declares.');
    return;
  }

  console.error('package-lock.json does not record the @next/swc-* binaries the way next build expects:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    'To fix: delete any node_modules/next/node_modules/@next/swc-* entries from package-lock.json, ' +
      'run `npm install` (it adds the missing top-level entries), re-run this check, ' +
      'and commit package-lock.json on its own.',
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
