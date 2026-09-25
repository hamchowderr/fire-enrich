/**
 * Whether this deployment has a Dolt database — the one check every part of
 * the app asks: the Dolt client (`lib/dolt.ts`), the enrichment route, the
 * run-history routes, `/api/check-env`, and the build, migrate and sweeper
 * scripts.
 *
 * Dolt is optional: it holds the versioned run history (recorded runs, their
 * commits, run diffs, the sweeper). Without it the app enriches, chats and
 * generates fields as usual and keeps no run history.
 *
 * Plain `.mjs` with no dependencies so `scripts/vercel-build.mjs` can import it
 * under plain Node, before and without any TypeScript tooling.
 */

/**
 * The variables that must be set for Dolt to count as configured.
 *
 * `DOLT_HOST` and `DOLT_DATABASE` are the two with no sensible default: a
 * host guess would connect to the wrong machine and a database guess would
 * read the wrong data. Port, user and password have defaults (a local
 * `dolt sql-server` is 127.0.0.1:3306, root, no password), and an empty
 * password is a legitimate local value, so `DOLT_PASSWORD=''` does not read as
 * "unconfigured".
 */
export const DOLT_REQUIRED_VARS = /** @type {const} */ (['DOLT_HOST', 'DOLT_DATABASE']);

/**
 * True when every variable in {@link DOLT_REQUIRED_VARS} is set and non-empty.
 *
 * A function rather than a constant: Next evaluates route modules at build
 * time, before the deployment's environment is present, and tests set these
 * variables per case.
 *
 * @param {Record<string, string | undefined>} [env] Defaults to `process.env`.
 * @returns {boolean}
 */
export function isDoltConfigured(env = process.env) {
  return DOLT_REQUIRED_VARS.every((name) => Boolean(env[name]));
}
