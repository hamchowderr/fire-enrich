/**
 * Where this deployment's libSQL database is: Turso when its url is set (see
 * {@link tursoConfig} for the names it is read from), a local SQLite file
 * otherwise.
 *
 * Two clients read it: Mastra's store (`lib/mastra/index.ts`) and the app's
 * own tables, business profiles and saved research plans (`lib/app-db.ts`).
 * Both use the same database, so one url and one token serve both, and a
 * deployment provisions nothing extra for profiles and plans. The app's
 * tables have their own names, and Mastra's are all prefixed `mastra_`.
 *
 * Plain `.mjs` with no dependencies beyond Node so
 * `scripts/libsql-migrate.mjs` can import it under plain Node.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * The project root, so the local file is the same file for every process.
 *
 * Two things make a bare relative path wrong here. libSQL opens the file
 * without creating its parent directory, so a missing `.mastra/` fails with
 * SQLITE_CANTOPEN; and a relative path resolves against each process's working
 * directory, so `mastra dev` and the Next.js app would silently use different
 * databases. `mastra build` emits the same warning in
 * `.mastra/output/preflight-local-paths.json`.
 *
 * Resolving against the project root fixes both. The root is found by walking
 * up to the nearest `package.json`, which holds wherever a process is started
 * from: `next dev` runs at the root, while the Mastra CLI runs from its own
 * directories (`lib/mastra/public` for the dev server, `.mastra/output` for a
 * build). Anything under `.mastra/` is trimmed off first, because the bundler
 * writes a generated `package.json` there that would otherwise end the walk in
 * the build output.
 *
 * @returns {string}
 */
function projectRoot() {
  const cwd = process.cwd();
  const buildDir = `${cwd}${path.sep}`.indexOf(`${path.sep}.mastra${path.sep}`);

  let dir = buildDir === -1 ? cwd : cwd.slice(0, buildDir);

  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return cwd; // reached the filesystem root
    dir = parent;
  }
}

/**
 * The one error a missing Turso configuration raises where the local file
 * cannot work, in place of a filesystem stack trace.
 */
const SERVERLESS_STORE_ERROR =
  'TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) is required on serverless: the local ' +
  'file store fallback at .mastra/fire-enrich.db needs a writable disk. A ' +
  '<PREFIX>_TURSO_DATABASE_URL and <PREFIX>_TURSO_AUTH_TOKEN pair, which the Vercel ' +
  'Marketplace Turso integration sets when it is connected with a custom prefix, also counts.';

/**
 * Whether a `mkdirSync` failure means the filesystem is not writable here, as
 * opposed to a fault worth surfacing as it is.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isReadOnlyFsError(err) {
  const code = /** @type {{ code?: unknown } | null} */ (err)?.code;
  return code === 'EROFS' || code === 'EACCES';
}

/**
 * The fallback for when no Turso url is set: an absolute `file:` url
 * for `.mastra/fire-enrich.db` under the project root, its directory created.
 *
 * On Vercel, `/var/task` is read-only, so the guard throws before any
 * filesystem call. Other read-only hosts are caught at the `mkdirSync` and
 * reported with the same message.
 *
 * @returns {string}
 */
function localStoreUrl() {
  if (process.env.VERCEL) throw new Error(SERVERLESS_STORE_ERROR);

  const file = path.join(projectRoot(), '.mastra', 'fire-enrich.db');
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    if (isReadOnlyFsError(err)) throw new Error(SERVERLESS_STORE_ERROR, { cause: err });
    throw err;
  }

  return `file:${file}`;
}

const PLAIN_URL = 'TURSO_DATABASE_URL';
const PLAIN_TOKEN = 'TURSO_AUTH_TOKEN';
const PREFIXED_URL = /^([A-Za-z][A-Za-z0-9_]*)_TURSO_DATABASE_URL$/;

/**
 * @param {string | undefined} value
 * @returns {string | undefined} The value, or undefined when it is unset, empty or whitespace.
 */
function present(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * @typedef {{ state: 'set', url: string, authToken: string | undefined, urlVar: string, tokenVar: string | undefined }
 *   | { state: 'unset' }
 *   | { state: 'ambiguous', urlVars: string[] }} TursoConfig
 */

/**
 * Which Turso database the environment names, and under which variables.
 *
 * Two namings are accepted:
 *
 * - `TURSO_DATABASE_URL` with `TURSO_AUTH_TOKEN`: set by hand, and the names
 *   the Vercel Marketplace Turso integration (`tursocloud`) sets by default.
 *   The token is optional here, as it is for a `file:` url or a local server.
 * - `<PREFIX>_TURSO_DATABASE_URL` with `<PREFIX>_TURSO_AUTH_TOKEN`: what the
 *   same integration sets when the project is connected with a custom prefix
 *   (Vercel prepends the prefix and an underscore to each name). Both halves
 *   must be set, under the same prefix.
 *
 * The plain url wins whenever it is set. A url is never paired with a token
 * of another naming or another prefix: a mixed pair does not count. Two or
 * more complete prefixed pairs, with no plain url, are `ambiguous`: which
 * database holds the data is not a guess to make.
 *
 * Values never leave this function except in the returned `url` and
 * `authToken`, which only the database clients read.
 *
 * @param {Record<string, string | undefined>} [env] Defaults to `process.env`.
 * @returns {TursoConfig}
 */
export function tursoConfig(env = process.env) {
  const plainUrl = present(env[PLAIN_URL]);
  if (plainUrl) {
    const token = present(env[PLAIN_TOKEN]);
    return { state: 'set', url: plainUrl, authToken: token, urlVar: PLAIN_URL, tokenVar: token ? PLAIN_TOKEN : undefined };
  }

  /** @type {{ url: string, authToken: string, urlVar: string, tokenVar: string }[]} */
  const pairs = [];
  for (const key of Object.keys(env).sort()) {
    const match = PREFIXED_URL.exec(key);
    if (!match) continue;
    const url = present(env[key]);
    const tokenVar = `${match[1]}_TURSO_AUTH_TOKEN`;
    const authToken = present(env[tokenVar]);
    if (url && authToken) pairs.push({ url, authToken, urlVar: key, tokenVar });
  }

  if (pairs.length === 0) return { state: 'unset' };
  if (pairs.length > 1) return { state: 'ambiguous', urlVars: pairs.map((pair) => pair.urlVar) };
  return { state: 'set', ...pairs[0] };
}

/**
 * The error for an `ambiguous` {@link tursoConfig}, naming variables only.
 *
 * @param {{ urlVars: string[] }} config
 * @returns {string}
 */
export function tursoAmbiguousMessage(config) {
  return (
    `Turso is ambiguous: ${config.urlVars.join(', ')} each name a database. ` +
    'Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to the one this app uses.'
  );
}

/**
 * The url and token to open the database with. `localStoreUrl()` is only
 * called when no Turso url is set, so a deployment using Turso never touches
 * the filesystem. `authToken` is undefined for a file, which libSQL accepts.
 *
 * @param {Record<string, string | undefined>} [env] Defaults to `process.env`.
 * @returns {{ url: string, authToken: string | undefined }}
 */
export function libsqlConnection(env = process.env) {
  const config = tursoConfig(env);
  if (config.state === 'ambiguous') throw new Error(tursoAmbiguousMessage(config));
  if (config.state === 'unset') return { url: localStoreUrl(), authToken: undefined };
  return { url: config.url, authToken: config.authToken };
}

/**
 * Whether a url names a local file (the fallback, or a `file:` url set by
 * hand or by the tests) rather than a remote Turso database.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isLocalFileUrl(url) {
  return url.startsWith('file:');
}
