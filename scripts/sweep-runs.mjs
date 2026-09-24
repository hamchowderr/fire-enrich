#!/usr/bin/env node
/**
 * Finish the enrichment runs a dead process left on their `run/<id>` branches.
 *
 *   DOLT_HOST=127.0.0.1 DOLT_PORT=3306 DOLT_USER=root DOLT_PASSWORD= \
 *   DOLT_DATABASE=fire_enrich npm run db:sweep-runs -- [--older-than-hours 6] [--dry-run]
 *
 * A branch whose run started more than `--older-than-hours` ago (default 6)
 * is abandoned. Its finished rows are committed and merged into `main` as a
 * `partial` run, the outcome a cancel gives; a run `main` already holds only
 * loses its branch. One line is printed per branch removed. `--dry-run` prints
 * what a sweep would do and writes nothing. See `sweepAbandonedRuns` in
 * `lib/runs.ts`, which does the work with the app's own commit and merge code.
 *
 * Exits 0 when every abandoned branch was swept, or there was none; 1 when
 * any branch failed, after sweeping the rest.
 *
 * `lib/runs.ts` is TypeScript. Node runs it with `--experimental-transform-types`
 * (the npm script passes it), and the resolve hook below maps the app's `@/`
 * path alias (tsconfig.json) to the repository root, as vitest.config.mts does.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = new URL('../', import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@/')) return nextResolve(specifier, context);
    const base = fileURLToPath(new URL(specifier.slice(2), ROOT));
    const file = [`${base}.ts`, `${base}.tsx`, base].find((candidate) => existsSync(candidate));
    return nextResolve(file ? pathToFileURL(file).href : specifier, context);
  },
});

const { values } = parseArgs({
  options: {
    'older-than-hours': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const { DEFAULT_SWEEP_HOURS, sweepAbandonedRuns } = await import('../lib/runs.ts');
const { doltConfigured } = await import('../lib/dolt.ts');

const olderThanHours = Number(values['older-than-hours'] ?? DEFAULT_SWEEP_HOURS);
const dryRun = values['dry-run'];

if (!doltConfigured()) {
  console.error('DOLT_HOST and DOLT_DATABASE are not set. See .env.example for the DOLT_* variables.');
  process.exit(1);
}
if (!(olderThanHours > 0)) {
  console.error(`--older-than-hours must be a positive number, not ${values['older-than-hours']}`);
  process.exit(1);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

try {
  const { swept, failed } = await sweepAbandonedRuns({ olderThanHours, dryRun });
  for (const branch of swept) {
    const tally = `${plural(branch.rows, 'row')}, ${plural(branch.enrichments, 'enrichment')}`;
    let line;
    if (branch.action === 'deleted') {
      line = `already merged at ${branch.commitHash}; ${dryRun ? 'would delete the branch' : 'branch deleted'}`;
    } else if (dryRun) {
      line = `would merge into main as ${branch.status} (${tally}) and delete the branch`;
    } else {
      line = `merged into main as ${branch.status} (${tally}) at ${branch.commitHash}; branch deleted`;
    }
    console.log(`${dryRun ? '[dry run] ' : 'swept '}${branch.branch}: ${line}`);
  }
  for (const { branch, error } of failed) console.error(`failed ${branch}: ${error}`);

  if (swept.length === 0 && failed.length === 0) {
    console.log(`No run branches older than ${olderThanHours}h.`);
  }
  process.exitCode = failed.length > 0 ? 1 : 0;
} catch (error) {
  console.error('Sweep failed');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

// The Dolt client keeps a pool open; nothing else is pending once the sweep is done.
process.exit();
