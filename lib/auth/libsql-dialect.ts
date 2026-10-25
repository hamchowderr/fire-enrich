/**
 * A Kysely dialect over the app's own libSQL helper (`lib/app-db.ts`), so
 * Better Auth's tables live in the same Turso database (or local file) as
 * profiles and plans and every statement goes through the same per-call
 * client, schema check and migration hint.
 *
 * `@libsql/kysely-libsql` exists, but it pins `@libsql/client` 0.8 and shares
 * one client between calls, which the module comment of `lib/app-db.ts`
 * explains is unsafe on a local file. Better Auth's Kysely adapter uses no
 * transactions when it is handed a dialect, so this one offers none.
 */
import {
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely';
import type { InValue } from '@libsql/client';

import { execute } from '@/lib/app-db';

const NO_TRANSACTIONS = 'The libSQL auth dialect runs each statement on its own client and has no transactions.';

class AppDbConnection implements DatabaseConnection {
  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const result = await execute({ sql: compiled.sql, args: compiled.parameters as InValue[] });
    return {
      rows: result.rows.map((row) => ({ ...row })) as R[],
      numAffectedRows: BigInt(result.rowsAffected),
      insertId: result.lastInsertRowid,
    };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('The libSQL auth dialect does not stream.');
  }
}

class AppDbDriver implements Driver {
  private readonly connection = new AppDbConnection();
  async init() {}
  async acquireConnection() {
    return this.connection;
  }
  async beginTransaction() {
    throw new Error(NO_TRANSACTIONS);
  }
  async commitTransaction() {
    throw new Error(NO_TRANSACTIONS);
  }
  async rollbackTransaction() {
    throw new Error(NO_TRANSACTIONS);
  }
  async releaseConnection() {}
  async destroy() {}
}

/** The dialect for Better Auth's `database: { dialect, type: 'sqlite' }`. */
export function appDbDialect(): Dialect {
  return {
    createAdapter: (): DialectAdapter => new SqliteAdapter(),
    createDriver: (): Driver => new AppDbDriver(),
    createQueryCompiler: (): QueryCompiler => new SqliteQueryCompiler(),
    createIntrospector: (db: Kysely<unknown>): DatabaseIntrospector => new SqliteIntrospector(db),
  };
}
