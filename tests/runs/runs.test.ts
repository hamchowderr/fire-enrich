import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnrichmentResult } from '@/lib/types';

import { configureDolt, installFakeDolt, isolateDoltEnv } from './fake-dolt';

/**
 * `lib/runs.ts` over a fake Dolt (`mysql2` mocked). What is asserted is the
 * SQL each step sends, on which branch, and in what order: the branch per run,
 * the per-row transactions, the run commit and its hash landing in
 * `commit_hash` through the merge into `main`.
 */
const { createPool, createConnection } = vi.hoisted(() => ({ createPool: vi.fn(), createConnection: vi.fn() }));

vi.mock('mysql2/promise', () => ({ default: { createPool, createConnection } }));

const fake = installFakeDolt(createPool, createConnection);
let restoreEnv: () => void;

async function loadRuns() {
  vi.resetModules();
  return import('@/lib/runs');
}

const enrichment = (overrides: Partial<EnrichmentResult> = {}): EnrichmentResult => ({
  field: 'headline',
  value: 'Power AI agents with clean web data',
  confidence: 0.91234,
  source: 'https://www.firecrawl.dev/',
  sourceContext: [{ url: 'https://www.firecrawl.dev/', snippet: 'Power AI agents with clean web data' }],
  sourceCount: 1,
  corroboration: {
    evidence: [
      {
        value: 'Power AI agents with clean web data',
        source_url: 'https://www.firecrawl.dev/',
        exact_text: 'Power AI agents with clean web data',
        confidence: 0.8,
      },
    ],
    sources_agree: true,
  },
  ...overrides,
});

/** The run id a started run was given, read from its branch connection. */
const branchOf = (runId: string) => `fire_enrich/run/${runId}`;

beforeEach(() => {
  restoreEnv = isolateDoltEnv();
  configureDolt();
  fake.reset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

describe('startRun', () => {
  it('branches run/<id> off main, opens a connection on it, and inserts the run as running', async () => {
    const { startRun } = await loadRuns();

    const runId = await startRun({ planId: 'plan_1', listRef: 'contacts.csv' });

    expect(fake.log[0]).toEqual({ on: 'pool', sql: 'CALL DOLT_BRANCH(?)', params: [`run/${runId}`] });
    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({ database: branchOf(runId), port: 3316 }));
    expect(fake.find(/INSERT INTO enrichment_runs/)).toEqual([
      {
        on: branchOf(runId),
        sql: 'INSERT INTO enrichment_runs (id, plan_id, list_ref, status) VALUES (?, ?, ?, ?)',
        params: [runId, 'plan_1', 'contacts.csv', 'running'],
      },
    ]);
    // Nothing is written to main, and nothing is committed, at start.
    expect(fake.find(/INSERT|DOLT_COMMIT/, 'pool')).toEqual([]);
  });

  it('records a null plan_id for a plan from the fallback', async () => {
    const { startRun } = await loadRuns();

    const runId = await startRun({ listRef: 'emails:sha256:abc (2 rows)' });

    expect(fake.find(/INSERT INTO enrichment_runs/)[0].params).toEqual([runId, null, 'emails:sha256:abc (2 rows)', 'running']);
  });

  it('falls back to a null plan_id when the plan row is not on main', async () => {
    const { startRun } = await loadRuns();
    let first = true;
    fake.respond(/INSERT INTO enrichment_runs/, () => {
      if (!first) return { affectedRows: 1 };
      first = false;
      throw Object.assign(new Error('cannot add or update a child row'), { errno: 1452, code: 'ER_NO_REFERENCED_ROW_2' });
    });

    const runId = await startRun({ planId: 'unsaved', listRef: 'x' });

    expect(fake.find(/INSERT INTO enrichment_runs/).map((statement) => statement.params[1])).toEqual(['unsaved', null]);
    expect(runId).toBeTruthy();
  });

  it('removes the branch again when the run row cannot be written', async () => {
    const { startRun } = await loadRuns();
    fake.respond(/INSERT INTO enrichment_runs/, () => {
      throw new Error('table not found: enrichment_runs');
    });

    await expect(startRun({ listRef: 'x' })).rejects.toThrow('table not found');

    const branch = fake.log[0].params[0];
    expect(fake.find(/DOLT_BRANCH\('-D'/)).toEqual([{ on: 'pool', sql: "CALL DOLT_BRANCH('-D', ?)", params: [branch] }]);
    expect(fake.connections[0].end).toHaveBeenCalled();
  });
});

describe('recordRow', () => {
  it('writes the enrichments, then their evidence, in one transaction on the run branch', async () => {
    const { recordRow, startRun } = await loadRuns();
    const runId = await startRun({ listRef: 'x' });

    const written = await recordRow(
      runId,
      'hello@firecrawl.dev',
      {
        headline: enrichment(),
        tags: enrichment({ field: 'tags', value: ['api', 'scraping'], confidence: 0.5, corroboration: undefined }),
      },
      { headline: 'browser', tags: 'search' }
    );

    expect(written).toBe(2);
    const onBranch = fake.log.filter((statement) => statement.on === branchOf(runId)).slice(1);
    expect(onBranch.map((statement) => statement.sql)).toEqual([
      'START TRANSACTION',
      'INSERT INTO enrichments (id, run_id, contact_email, field, value, confidence, strategy) VALUES ?',
      'INSERT INTO evidence (id, enrichment_id, url, quote, confidence) VALUES ?',
      'COMMIT',
    ]);

    const [enrichmentRows] = onBranch[1].params as [unknown[][]];
    expect(enrichmentRows.map((row) => row.slice(1))).toEqual([
      [runId, 'hello@firecrawl.dev', 'headline', 'Power AI agents with clean web data', 0.912, 'browser'],
      [runId, 'hello@firecrawl.dev', 'tags', '["api","scraping"]', 0.5, 'search'],
    ]);

    // Evidence rows point at their enrichment. The corroborating quote carries
    // its own confidence; a result without corroboration falls back to its
    // source contexts at the field's confidence.
    const [evidenceRows] = onBranch[2].params as [unknown[][]];
    expect(evidenceRows.map((row) => row.slice(1))).toEqual([
      [enrichmentRows[0][0], 'https://www.firecrawl.dev/', 'Power AI agents with clean web data', 0.8],
      [enrichmentRows[1][0], 'https://www.firecrawl.dev/', 'Power AI agents with clean web data', 0.5],
    ]);
  });

  it('writes nothing for a row with no enrichments', async () => {
    const { recordRow, startRun } = await loadRuns();
    const runId = await startRun({ listRef: 'x' });

    expect(await recordRow(runId, 'a@b.example', {})).toBe(0);
    expect(fake.find(/START TRANSACTION|INSERT INTO enrichments/, branchOf(runId))).toEqual([]);
  });

  it('writes rows that finish together one after the other, never interleaved', async () => {
    const { recordRow, startRun } = await loadRuns();
    const runId = await startRun({ listRef: 'x' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    fake.respond(/INSERT INTO enrichments/, async () => {
      calls += 1;
      if (calls === 1) await held;
      return { affectedRows: 1 };
    });

    const first = recordRow(runId, 'first@a.example', { headline: enrichment() });
    const second = recordRow(runId, 'second@b.example', { headline: enrichment() });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([first, second]);

    const writes = fake
      .find(/START TRANSACTION|INSERT INTO|COMMIT/, branchOf(runId))
      .filter((statement) => !/enrichment_runs/.test(statement.sql))
      .map((statement) =>
        /INSERT INTO enrichments/.test(statement.sql)
          ? `enrichments:${(statement.params[0] as unknown[][])[0][2]}`
          : statement.sql.split(' ')[0] + (/evidence/.test(statement.sql) ? ':evidence' : '')
      );
    expect(writes).toEqual([
      'START',
      'enrichments:first@a.example',
      'INSERT:evidence',
      'COMMIT',
      'START',
      'enrichments:second@b.example',
      'INSERT:evidence',
      'COMMIT',
    ]);
  });

  it('rolls back a row whose write fails, and the next row still writes', async () => {
    const { recordRow, startRun } = await loadRuns();
    const runId = await startRun({ listRef: 'x' });
    let calls = 0;
    fake.respond(/INSERT INTO evidence/, () => {
      calls += 1;
      if (calls === 1) throw new Error('data too long for column url');
      return { affectedRows: 1 };
    });

    await expect(recordRow(runId, 'a@a.example', { headline: enrichment() })).rejects.toThrow('data too long');
    await expect(recordRow(runId, 'b@b.example', { headline: enrichment() })).resolves.toBe(1);

    expect(fake.find(/^ROLLBACK$/, branchOf(runId))).toHaveLength(1);
  });

  it('refuses a run this process did not start', async () => {
    const { recordRow } = await loadRuns();

    expect(() => recordRow('nope', 'a@b.example', {})).toThrow('not in progress');
  });
});

describe('finishRun', () => {
  it('commits the branch, merges it into main with the hash in commit_hash, and drops the branch', async () => {
    const { finishRun, recordRow, startRun } = await loadRuns();
    const runId = await startRun({ planId: 'plan_1', listRef: 'contacts.csv' });
    await recordRow(runId, 'hello@firecrawl.dev', { headline: enrichment() }, { headline: 'browser' });

    const hash = await finishRun(runId, 'completed');

    // The run's own commit, on its branch, after the status update.
    const onBranch = fake.log.filter((statement) => statement.on === branchOf(runId));
    expect(onBranch.slice(-2)).toEqual([
      {
        on: branchOf(runId),
        sql: 'UPDATE enrichment_runs SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
        params: ['completed', runId],
      },
      {
        on: branchOf(runId),
        sql: "CALL DOLT_COMMIT('-Am', ?, '--author', ?)",
        params: [expect.any(String), 'Fire Enrich <fire-enrich@localhost>'],
      },
    ]);
    expect(hash).toBe(fake.hashes[0]);

    const message = onBranch.at(-1)!.params[0] as string;
    expect(message.split('\n')).toEqual([
      `Enrichment run ${runId}: completed, 1 row, 1 enrichment`,
      '',
      `Run-Id: ${runId}`,
      'Plan-Id: plan_1',
      'List-Ref: contacts.csv',
      'Status: completed',
    ]);

    // Then the merge, on its own connection to main, in one SQL transaction.
    const onMain = fake.log.filter((statement) => statement.on === 'fire_enrich');
    expect(onMain.map(({ sql, params }) => [sql, params])).toEqual([
      ['START TRANSACTION', []],
      ["CALL DOLT_MERGE('--no-ff', '--no-commit', ?)", [`run/${runId}`]],
      ['UPDATE enrichment_runs SET commit_hash = ? WHERE id = ?', [hash, runId]],
      ["CALL DOLT_COMMIT('-Am', ?, '--author', ?)", [`Merge ${message}`, 'Fire Enrich <fire-enrich@localhost>']],
      ['COMMIT', []],
    ]);

    expect(fake.log.at(-1)).toEqual({ on: 'pool', sql: "CALL DOLT_BRANCH('-d', ?)", params: [`run/${runId}`] });
    for (const connection of fake.connections) expect(connection.end).toHaveBeenCalled();
  });

  it('marks a cancelled run partial and still commits the rows that finished', async () => {
    const { finishRun, recordRow, startRun } = await loadRuns();
    const runId = await startRun({ listRef: 'x' });
    const pending = recordRow(runId, 'done@a.example', { headline: enrichment() });

    await finishRun(runId, 'partial');
    await pending;

    const statements = fake.log.filter((statement) => statement.on === branchOf(runId)).map((statement) => statement.sql);
    // The row's write lands before the status update and the commit.
    expect(statements.indexOf('COMMIT')).toBeLessThan(
      statements.indexOf('UPDATE enrichment_runs SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?')
    );
    expect(fake.find(/SET status/)[0].params).toEqual(['partial', runId]);
    expect(fake.find(/DOLT_COMMIT/, branchOf(runId))[0].params[0]).toMatch(/: partial, 1 row, 1 enrichment/);
  });

  it('uses DOLT_COMMIT_AUTHOR, and the default when it is malformed', async () => {
    const { finishRun, startRun } = await loadRuns();
    const authors = () => fake.find(/DOLT_COMMIT/).map((statement) => statement.params[1]);

    process.env.DOLT_COMMIT_AUTHOR = 'Run Bot <runs@example.com>';
    await finishRun(await startRun({ listRef: 'x' }), 'failed');
    // Both the run commit and the merge carry the configured author.
    expect(authors()).toEqual(['Run Bot <runs@example.com>', 'Run Bot <runs@example.com>']);

    fake.reset();
    process.env.DOLT_COMMIT_AUTHOR = 'no email here';
    await finishRun(await startRun({ listRef: 'x' }), 'completed');
    expect(authors()).toEqual(['Fire Enrich <fire-enrich@localhost>', 'Fire Enrich <fire-enrich@localhost>']);
  });

  it('gives two concurrent runs their own branch, commit and hash, and merges them one at a time', async () => {
    const { finishRun, recordRow, startRun } = await loadRuns();
    const [a, b] = await Promise.all([startRun({ listRef: 'a' }), startRun({ listRef: 'b' })]);
    await Promise.all([
      recordRow(a, 'a@a.example', { headline: enrichment() }),
      recordRow(b, 'b@b.example', { headline: enrichment() }),
    ]);

    const [hashA, hashB] = await Promise.all([finishRun(a, 'completed'), finishRun(b, 'completed')]);

    expect(hashA).not.toBe(hashB);
    // Each run's rows went only to its own branch.
    for (const [runId, email] of [
      [a, 'a@a.example'],
      [b, 'b@b.example'],
    ]) {
      const inserts = fake.find(/INSERT INTO enrichments/).filter((statement) => statement.on === branchOf(runId));
      expect(inserts.map((statement) => (statement.params[0] as unknown[][])[0][2])).toEqual([email]);
    }
    expect(fake.find(/INSERT INTO enrichments/, 'pool')).toEqual([]);

    // The merges into main do not overlap: the second transaction starts after
    // the first one commits.
    const onMain = fake.log
      .filter((statement) => statement.on === 'fire_enrich')
      .map((statement) => (statement.sql === 'START TRANSACTION' || statement.sql === 'COMMIT' ? statement.sql : '·'));
    expect(onMain.filter((sql) => sql !== '·')).toEqual(['START TRANSACTION', 'COMMIT', 'START TRANSACTION', 'COMMIT']);
    expect(fake.find(/SET commit_hash/).map((statement) => statement.params)).toEqual(
      expect.arrayContaining([
        [hashA, a],
        [hashB, b],
      ])
    );
  });

  it('retries a merge that lost a race with another instance', async () => {
    const { finishRun, startRun } = await loadRuns();
    const runId = await startRun({ listRef: 'x' });
    let merges = 0;
    fake.respond(/DOLT_MERGE/, () => {
      merges += 1;
      if (merges === 1) throw new Error('this transaction conflicts with a committed transaction from another client, try restarting transaction');
      return [[{ hash: '', fast_forward: 0, conflicts: 0 }]];
    });

    await expect(finishRun(runId, 'completed')).resolves.toBeTruthy();
    expect(merges).toBe(2);
    expect(fake.find(/^ROLLBACK$/, 'fire_enrich')).toHaveLength(1);
  });

  it('rolls the merge back and throws when it conflicts, keeping the branch', async () => {
    const { finishRun, startRun } = await loadRuns();
    const runId = await startRun({ listRef: 'x' });
    fake.respond(/DOLT_MERGE/, () => [[{ hash: '', fast_forward: 0, conflicts: 1 }]]);

    await expect(finishRun(runId, 'completed')).rejects.toThrow('conflicted');
    expect(fake.find(/^ROLLBACK$/, 'fire_enrich')).toHaveLength(1);
    expect(fake.find(/DOLT_BRANCH\('-d'/)).toEqual([]);
  });
});

describe('listRefFor', () => {
  it('keeps a given reference and fingerprints the emails otherwise', async () => {
    const { listRefFor } = await loadRuns();
    const rows = [{ email: 'A@x.example' }, { email: 'b@y.example' }];

    expect(listRefFor('  contacts.csv ', rows, 'email')).toBe('contacts.csv');
    expect(listRefFor(undefined, rows, 'email')).toMatch(/^emails:sha256:[0-9a-f]{16} \(2 rows\)$/);
    expect(listRefFor(undefined, rows, 'email')).toBe(listRefFor('', [{ email: 'a@x.example' }, { email: 'b@y.example' }], 'email'));
    expect(listRefFor(undefined, [rows[0]], 'email')).not.toBe(listRefFor(undefined, rows, 'email'));
  });
});
