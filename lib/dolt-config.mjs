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
 * Every variable that describes a Dolt connection. Setting any of them is a
 * sign Dolt was meant to be on, so a set that lacks a required variable is a
 * misconfiguration, not "Dolt off". `DOLT_COMMIT_AUTHOR` and
 * `DOLT_PREVIEW_MIGRATE` are not here: they tune a Dolt that is on and say
 * nothing about whether one was meant to be.
 */
const DOLT_CONNECTION_VARS = /** @type {const} */ ([
  'DOLT_HOST',
  'DOLT_PORT',
  'DOLT_USER',
  'DOLT_PASSWORD',
  'DOLT_DATABASE',
  'DOLT_TLS_CA_B64',
]);

/**
 * Set means present with something other than whitespace.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {boolean}
 */
function isSet(env, name) {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * @typedef {{ state: 'off' } | { state: 'on' } | { state: 'misconfigured', missing: string[], set: string[] }} DoltConfigState
 */

/**
 * Where this environment stands on Dolt:
 *
 * - `off`: no connection variable is set. Dolt is optional; this is a
 *   supported mode.
 * - `on`: every variable in {@link DOLT_REQUIRED_VARS} is set.
 * - `misconfigured`: some connection variables are set but a required one is
 *   missing (or whitespace only). The build, `db:migrate` and the sweeper
 *   fail on it and the runtime warns, so a typo in `DOLT_DATABASE` cannot
 *   silently switch run history off.
 *
 * A function rather than a constant: Next evaluates route modules at build
 * time, before the deployment's environment is present, and tests set these
 * variables per case.
 *
 * @param {Record<string, string | undefined>} [env] Defaults to `process.env`.
 * @returns {DoltConfigState}
 */
export function doltConfigState(env = process.env) {
  const missing = DOLT_REQUIRED_VARS.filter((name) => !isSet(env, name));
  if (missing.length === 0) return { state: 'on' };

  const set = DOLT_CONNECTION_VARS.filter((name) => isSet(env, name));
  if (set.length === 0) return { state: 'off' };

  return { state: 'misconfigured', missing, set };
}

/**
 * True when Dolt is on ({@link doltConfigState} is `on`). A misconfigured
 * Dolt is not configured: nothing connects to it.
 *
 * @param {Record<string, string | undefined>} [env] Defaults to `process.env`.
 * @returns {boolean}
 */
export function isDoltConfigured(env = process.env) {
  return doltConfigState(env).state === 'on';
}

/**
 * The one message every caller prints for a misconfigured Dolt.
 *
 * @param {{ missing: string[], set: string[] }} config
 * @returns {string}
 */
export function doltMisconfiguredMessage({ missing, set }) {
  return (
    `Dolt is misconfigured: ${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set but ` +
    `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing. ` +
    `Set ${DOLT_REQUIRED_VARS.join(' and ')} to enable Dolt, or unset every DOLT_* connection variable to run without it.`
  );
}

/**
 * A hint to append to a connection error. "Access denied" with no
 * `DOLT_PASSWORD` set usually means the password was left out, and the
 * driver's message does not name the variable. Empty for any other error.
 *
 * @param {unknown} error
 * @param {Record<string, string | undefined>} [env] Defaults to `process.env`.
 * @returns {string}
 */
export function doltAccessDeniedHint(error, env = process.env) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/access denied/i.test(message) || isSet(env, 'DOLT_PASSWORD')) return '';
  return ' (DOLT_PASSWORD is empty or unset: set it if the Dolt user has a password)';
}
