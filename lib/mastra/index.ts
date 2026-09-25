import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';

import { browserAgent } from './agents/browser';
import { chatAgent } from './agents/chat';
import { identifyAgent } from './agents/identify';
import { plannerAgent } from './agents/planner';
import { researchAgent } from './agents/research';
import { configureAIMock } from './lib/aimock';
import { enrichRowWorkflow } from './workflows/enrich-row';

// Route OpenAI-compatible clients at AIMock when `USE_AIMOCK=true`. Runs before
// the Mastra instance is built and before anything else in this process reads
// `OPENAI_BASE_URL`. The agents imported above already resolve their model
// through `resolveModel()`, which points at AIMock explicitly, so import order
// cannot bypass the switch for them.
configureAIMock();

/**
 * Absolute `file:` url for the local fallback database.
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
 */
function projectRoot(): string {
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
 * store cannot work, in place of a filesystem stack trace.
 */
const SERVERLESS_STORE_ERROR =
  'TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) is required on serverless: the local ' +
  'file store fallback at .mastra/fire-enrich.db needs a writable disk.';

/**
 * Whether a `mkdirSync` failure means the filesystem is not writable here, as
 * opposed to a fault worth surfacing as it is.
 */
function isReadOnlyFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EROFS' || code === 'EACCES';
}

/**
 * The fallback for when `TURSO_DATABASE_URL` is unset.
 *
 * On Vercel, `/var/task` is read-only, so the guard throws before any
 * filesystem call. Other read-only hosts are caught at the `mkdirSync` and
 * reported with the same message.
 */
function localStoreUrl(): string {
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

function createMastra() {
  return new Mastra({
    /**
     * LibSQL serves both deployment shapes from one adapter.
     *
     * With `TURSO_DATABASE_URL` set, this talks to Turso over the network, which
     * is what serverless needs: instances are ephemeral and share no disk.
     * With the variable unset, it falls back to a local SQLite file so a fresh
     * clone runs with no database to provision. `authToken` is undefined for the
     * file path, which the adapter accepts.
     *
     * `localStoreUrl()` is only called on the fallback path, so a deployment
     * using Turso never touches the filesystem.
     */
    storage: new LibSQLStore({
      id: 'fire-enrich-storage',
      url: process.env.TURSO_DATABASE_URL ?? localStoreUrl(),
      authToken: process.env.TURSO_AUTH_TOKEN,
    }),
    agents: {
      /**
       * Attached by the research agent as its `agent-browser` sub-agent tool,
       * for a group whose planned strategy is `browser` and only then.
       * Registered so Studio can drive it on its own.
       */
      browser: browserAgent,
      planner: plannerAgent,
      identify: identifyAgent,
      research: researchAgent,
      /** Answers the chat panel: from the enriched table, or from the web. */
      chat: chatAgent,
    },
    workflows: {
      enrichRow: enrichRowWorkflow,
    },
  });
}

type MastraInstance = ReturnType<typeof createMastra>;

/**
 * Cache the instance on `globalThis`.
 *
 * Turbopack re-evaluates route modules on edit, and each evaluation would
 * otherwise build a second Mastra instance holding a second LibSQL client. Two
 * clients on the same local SQLite file contend for the same write lock, and on
 * Turso they double the connection count. Caching outside the module registry
 * keeps exactly one instance per process.
 */
const globalForMastra = globalThis as typeof globalThis & {
  __fireEnrichMastra?: MastraInstance;
};

export const mastra: MastraInstance = (globalForMastra.__fireEnrichMastra ??= createMastra());
