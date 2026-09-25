#!/usr/bin/env node
/**
 * Finish the enrichment runs a dead process left on their `run/<id>` branches.
 *
 *   DOLT_HOST=127.0.0.1 DOLT_PORT=3306 DOLT_USER=root DOLT_PASSWORD= \
 *   DOLT_DATABASE=fire_enrich npm run db:sweep-runs -- [--older-than-hours 6] [--dry-run]
 *
 * A branch idle for more than `--older-than-hours` (default 6) is abandoned:
 * its run's heartbeat (`last_activity_at`), finish and branch commit are all
 * older than that. Its finished rows are committed and merged into `main`: as
 * a `partial` run, the outcome a cancel gives, or as `failed` when the app
 * gave the run up after a failed write. A run `main` already holds only loses
 * its branch. One line is printed per branch removed. `--dry-run` prints what
 * a sweep would do and writes nothing. See `sweepAbandonedRuns` in
 * `lib/runs.ts`, which does the work with the app's own commit and merge code,
 * and says how idle time is measured.
 *
 * Exits 0 when every abandoned branch was swept, or there was none; 1 when
 * any branch failed, after sweeping the rest, or Dolt is unreachable; 2 on a
 * usage error.
 *
 * Dolt is optional. With no `DOLT_*` connection variable set no run was ever
 * recorded, so there is nothing to sweep: the script prints one "requires
 * Dolt" line and exits 0, so a scheduled sweep on a deployment without Dolt is
 * a no-op rather than a failure. With some set but `DOLT_HOST` or
 * `DOLT_DATABASE` missing, it names what is missing and exits 1.
 *
 * `lib/runs.ts` is TypeScript, which Node 24 loads by stripping its types. The
 * resolve hook below maps the app's `@/` path alias (tsconfig.json) to the
 * repository root, as vitest.config.mts does.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = 'Usage: npm run db:sweep-runs -- [--older-than-hours <hours>] [--dry-run]';

/** Print `message` and the usage line, and exit 2. */
function usageError(message) {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      'older-than-hours': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  }));
} catch (error) {
  usageError(error instanceof Error ? error.message : String(error));
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const hoursFlag = values['older-than-hours'];
if (hoursFlag !== undefined && !(Number(hoursFlag) > 0)) {
  usageError(`--older-than-hours must be a positive number, not ${hoursFlag}`);
}

const ROOT = new URL('../', import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@/')) return nextResolve(specifier, context);
    const base = fileURLToPath(new URL(specifier.slice(2), ROOT));
    const file = [`${base}.ts`, `${base}.tsx`, base].find((candidate) => existsSync(candidate));
    return nextResolve(file ? pathToFileURL(file).href : specifier, context);
  },
});

const { DEFAULT_SWEEP_HOURS, sweepAbandonedRuns } = await import('../lib/runs.ts');
const { DOLT_REQUIRED_VARS, doltConfigState, doltMisconfiguredMessage } = await import('../lib/dolt-config.mjs');

const olderThanHours = hoursFlag === undefined ? DEFAULT_SWEEP_HOURS : Number(hoursFlag);
const dryRun = values['dry-run'];

const doltConfig = doltConfigState();
if (doltConfig.state === 'misconfigured') {
  console.error(doltMisconfiguredMessage(doltConfig));
  process.exit(1);
}
if (doltConfig.state === 'off') {
  console.log(
    `db:sweep-runs requires Dolt, which is not configured (optional; set ${DOLT_REQUIRED_VARS.join(' and ')} to enable it). No runs are recorded without it, so there is nothing to sweep.`
  );
  process.exit(0);
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
