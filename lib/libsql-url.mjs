/**
 * Where this deployment's libSQL database is: Turso when `TURSO_DATABASE_URL`
 * is set, a local SQLite file otherwise.
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
  'file store fallback at .mastra/fire-enrich.db needs a writable disk.';

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
 * The fallback for when `TURSO_DATABASE_URL` is unset: an absolute `file:` url
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

/**
 * The url and token to open the database with. `localStoreUrl()` is only
 * called when `TURSO_DATABASE_URL` is unset, so a deployment using Turso never
 * touches the filesystem. `authToken` is undefined for a file, which libSQL
 * accepts.
 *
 * @param {Record<string, string | undefined>} [env] Defaults to `process.env`.
 * @returns {{ url: string, authToken: string | undefined }}
 */
export function libsqlConnection(env = process.env) {
  return {
    url: env.TURSO_DATABASE_URL ?? localStoreUrl(),
    authToken: env.TURSO_AUTH_TOKEN,
  };
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
