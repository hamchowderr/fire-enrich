#!/usr/bin/env node
/**
 * Apply the app's libSQL schema (`lib/app-db-schema.mjs`: profiles and saved
 * research plans) to this deployment's libSQL database.
 *
 *   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... npm run db:migrate:libsql
 *   npm run db:migrate:libsql          # no TURSO_*: the local .mastra/fire-enrich.db
 *
 * The npm script reads `.env` and `.env.local` (`--env-file-if-exists` in
 * package.json); a variable already set in the environment wins over both.
 *
 * The database is the one Mastra's store uses (`lib/libsql-url.mjs`): Turso
 * when `TURSO_DATABASE_URL` is set (or a `<PREFIX>_TURSO_DATABASE_URL` and
 * `<PREFIX>_TURSO_AUTH_TOKEN` pair from the Vercel Marketplace integration),
 * the local file otherwise. Every statement
 * is `IF NOT EXISTS` and they run as one write batch, one transaction, so a
 * re-run changes nothing and a failure leaves nothing half-applied.
 *
 * The Vercel build (`scripts/vercel-build.mjs`) runs this after `next build`
 * on production, and on Preview with `LIBSQL_PREVIEW_MIGRATE=1`; a failure
 * exits non-zero and fails the deployment. Off Vercel the app applies the
 * same statements itself on first use; on Vercel only this script does.
 *
 * Plain `.mjs`, like the other scripts: it runs under plain Node.
 */
import process from 'node:process';

import { createClient } from '@libsql/client';

import { applyAppDbSchema, APP_DB_STATEMENTS } from '../lib/app-db-schema.mjs';
import { isLocalFileUrl, libsqlConnection } from '../lib/libsql-url.mjs';

/** Where the migration ran, without the token or any query string. */
function describe(url) {
  return isLocalFileUrl(url) ? url : url.replace(/[?#].*$/, '');
}

async function main() {
  const { url, authToken } = libsqlConnection();
  const client = createClient({ url, authToken });

  try {
    const created = await applyAppDbSchema(client);
    const target = describe(url);

    if (created.length === 0) {
      console.log(
        `libSQL ${target}: ${APP_DB_STATEMENTS.length} statements applied, nothing changed.`
      );
      return;
    }
    console.log(
      `libSQL ${target}: ${APP_DB_STATEMENTS.length} statements applied, created ${created.join(', ')}.`
    );
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error('libSQL migration failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
