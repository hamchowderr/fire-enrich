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
 * Which builds migrate is decided by {@link migrationPlan} from `VERCEL_ENV`,
 * which Vercel sets at build time to `production`, `preview` or `development`:
 *
 * - `production`: migrates when `DOLT_HOST` and `DOLT_DATABASE` are set.
 * - `preview`: migrates only when `DOLT_PREVIEW_MIGRATE=1` is also set. Preview
 *   deploys build unmerged branches, and Preview may point at the production
 *   database, so a Preview build must never change a schema by default. Set
 *   the flag on the Preview environment only after Preview's `DOLT_*` point at
 *   a database that no production deploy uses.
 * - anything else, including no `VERCEL_ENV` at all: no migration.
 *
 * The build runs first, so a build that fails changes no schema. A migration
 * that fails exits non-zero, which fails the deployment, so new code never
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

const MIGRATE_SCRIPT = fileURLToPath(new URL('./db-migrate.mjs', import.meta.url));

/**
 * Decide whether this build applies migrations.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ migrate: boolean, reason: string }}
 */
export function migrationPlan(env) {
  const target = env.VERCEL_ENV;
  const configured = Boolean(env.DOLT_HOST && env.DOLT_DATABASE);

  if (target === 'production') {
    return configured
      ? { migrate: true, reason: 'production build' }
      : { migrate: false, reason: 'production build, but DOLT_HOST and DOLT_DATABASE are not set' };
  }

  if (target === 'preview') {
    if (env.DOLT_PREVIEW_MIGRATE !== '1') {
      return {
        migrate: false,
        reason: 'preview build; set DOLT_PREVIEW_MIGRATE=1 on Preview only when it has its own database',
      };
    }
    return configured
      ? { migrate: true, reason: 'preview build with DOLT_PREVIEW_MIGRATE=1' }
      : { migrate: false, reason: 'preview build, but DOLT_HOST and DOLT_DATABASE are not set' };
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
  // The npm that started this script (`npm run build:vercel` sets
  // npm_execpath), run by this Node, so no shell is needed on any platform.
  const npm = process.env.npm_execpath;
  if (npm) run(process.execPath, [npm, 'run', 'build']);
  else run('npm', ['run', 'build']);

  const plan = migrationPlan(process.env);
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
