#!/usr/bin/env node
/**
 * The Vercel build: `next build`, then `db/schema.sql` applied to the
 * deployment's Dolt database when this environment owns one.
 *
 *   npm run build:vercel    # vercel.json "buildCommand"
 *
 * Vercel runs this instead of `npm run build`. Locally `npm run build` is still
 * plain `next build` and needs no database.
 *
 * Dolt is optional (`doltConfigState()` in `lib/dolt-config.mjs`):
 *
 * - No `DOLT_*` connection variable set: the build logs one line and skips
 *   the migration, on every environment, and succeeds. A one-click deploy
 *   with only the required services builds cleanly.
 * - Some set but `DOLT_HOST` or `DOLT_DATABASE` missing: a misconfiguration.
 *   The build fails before `next build`, naming the missing variables, rather
 *   than deploying with run history silently off.
 *
 * With Dolt configured, which builds migrate is decided by {@link migrationPlan}
 * from `VERCEL_ENV`, which Vercel sets at build time to `production`,
 * `preview` or `development`:
 *
 * - `production`: migrates.
 * - `preview`: migrates only when `DOLT_PREVIEW_MIGRATE=1` is also set. Preview
 *   deploys build unmerged branches, and Preview may point at the production
 *   database, so a Preview build must never change a schema by default. Set
 *   the flag on the Preview environment only after Preview's `DOLT_*` point at
 *   a database that no production deploy uses.
 * - anything else, including no `VERCEL_ENV` at all: no migration.
 *
 * The build runs first, so a build that fails changes no schema. A configured
 * migration that fails exits non-zero, which fails the deployment, so new code never
 * serves traffic against an old schema. `scripts/db-migrate.mjs` is
 * idempotent: on an up-to-date database it changes nothing and commits
 * nothing.
 *
 * The migration runs before the new deployment serves traffic, while the
 * previous deployment is still live, so every change to `db/schema.sql` must
 * be additive and backwards-compatible (see CLAUDE.md).
 *
 * Plain `.mjs` with no dependencies beyond Node, like the other scripts here.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DOLT_REQUIRED_VARS, doltConfigState, doltMisconfiguredMessage } from '../lib/dolt-config.mjs';

const MIGRATE_SCRIPT = fileURLToPath(new URL('./db-migrate.mjs', import.meta.url));

/**
 * Decide whether this build applies migrations.
 *
 * `fail` is set for a misconfigured Dolt: the build must stop, not skip.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ migrate: boolean, fail?: boolean, reason: string }}
 */
export function migrationPlan(env) {
  // Checked first, on every environment: without Dolt there is nothing to
  // migrate, and that is a supported mode; a partial Dolt is an error.
  const config = doltConfigState(env);
  if (config.state === 'misconfigured') {
    return { migrate: false, fail: true, reason: doltMisconfiguredMessage(config) };
  }
  if (config.state === 'off') {
    return {
      migrate: false,
      reason: `Dolt is not configured (optional; set ${DOLT_REQUIRED_VARS.join(' and ')} to enable it)`,
    };
  }

  const target = env.VERCEL_ENV;

  if (target === 'production') return { migrate: true, reason: 'production build' };

  if (target === 'preview') {
    return env.DOLT_PREVIEW_MIGRATE === '1'
      ? { migrate: true, reason: 'preview build with DOLT_PREVIEW_MIGRATE=1' }
      : {
          migrate: false,
          reason: 'preview build; set DOLT_PREVIEW_MIGRATE=1 on Preview only when it has its own database',
        };
  }

  return { migrate: false, reason: `VERCEL_ENV is ${target ? `"${target}"` : 'not set'}` };
}

/** Run a command with inherited output; exit with its status when it fails. */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
}

function main() {
  // Decided before the build, so a misconfigured Dolt fails in seconds.
  const plan = migrationPlan(process.env);
  if (plan.fail) {
    console.error(`db:migrate: ${plan.reason}`);
    process.exit(1);
  }

  // The npm that started this script (`npm run build:vercel` sets
  // npm_execpath), run by this Node, so no shell is needed on any platform.
  const npm = process.env.npm_execpath;
  if (npm) run(process.execPath, [npm, 'run', 'build']);
  else run('npm', ['run', 'build']);

  if (!plan.migrate) {
    console.log(`db:migrate skipped: ${plan.reason}.`);
    return;
  }

  console.log(`db:migrate: ${plan.reason}.`);
  run(process.execPath, [MIGRATE_SCRIPT]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
