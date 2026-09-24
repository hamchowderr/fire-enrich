import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureDolt, installFakeDolt, isolateDoltEnv, type Statement } from './fake-dolt';

/**
 * `sweepAbandonedRuns` over the fake Dolt. A branch is set up the way a dead
 * process leaves it: listed in `dolt_branches`, with a run row on the branch
 * (its age as `TIMESTAMPDIFF` answers it) and, unless the merge landed, no
 * row on `main`. What is asserted is the SQL the sweep sends, and where.
 */
const { createPool, createConnection } = vi.hoisted(() => ({ createPool: vi.fn(), createConnection: vi.fn() }));

vi.mock('mysql2/promise', () => ({ default: { createPool, createConnection } }));

const fake = installFakeDolt(createPool, createConnection);
let restoreEnv: () => void;

const HOUR = 3600;
const AUTHOR = 'Fire Enrich <fire-enrich@localhost>';
const WRITES = /UPDATE|INSERT|DELETE|DOLT_COMMIT|DOLT_MERGE|DOLT_BRANCH/;

interface Branch {
  id: string;
  ageSeconds: number;
  status?: string;
  /** `commit_hash` of the run's row on `main`; no row on `main` when absent. */
  onMain?: string | null;
  contacts?: number;
  enrichments?: number;
  /** No run row on the branch at all. */
  noRow?: boolean;
}

const branchDb = (id: string) => `fire_enrich/run/${id}`;

/** Answer the sweep's reads for these branches. */
function setUp(branches: Branch[]) {
  const byDb = new Map(branches.map((branch) => [branchDb(branch.id), branch]));

  fake.respond(/FROM dolt_branches/, () => branches.map((branch) => ({ name: `run/${branch.id}` })));
  fake.respond(/TIMESTAMPDIFF/, ({ on }: Statement) => {
    const branch = byDb.get(on);
    if (!branch || branch.noRow) return [];
    return [
      {
        id: branch.id,
        plan_id: 'plan_1',
        list_ref: 'contacts.csv',
        status: branch.status ?? 'running',
        age_seconds: String(branch.ageSeconds),
      },
    ];
  });
  fake.respond(/COUNT\(DISTINCT contact_email\)/, ({ on }: Statement) => {
    const branch = byDb.get(on);
    return [{ contacts: branch?.contacts ?? 0, enrichments: branch?.enrichments ?? 0 }];
  });
  fake.respond(/SELECT commit_hash FROM enrichment_runs/, ({ params }: Statement) => {
    const branch = branches.find((candidate) => candidate.id === params[0]);
    return branch?.onMain === undefined ? [] : [{ commit_hash: branch.onMain }];
  });
}

async function loadRuns() {
  vi.resetModules();
  return import('@/lib/runs');
}

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

describe('sweepAbandonedRuns', () => {
  it('commits an abandoned branch and merges it into main as a partial run, then deletes it', async () => {
    setUp([{ id: 'dead1', ageSeconds: 7 * HOUR, contacts: 2, enrichments: 5 }]);
    const { sweepAbandonedRuns } = await loadRuns();

    const result = await sweepAbandonedRuns();

    // On the branch: the run row becomes partial with finished_at, and the
    // working set, rows included, is committed.
    const onBranch = fake.find(WRITES, branchDb('dead1'));
    expect(onBranch.map(({ sql, params }) => [sql, params])).toEqual([
      [
        "UPDATE enrichment_runs SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'",
        ['partial', 'dead1'],
      ],
      ["CALL DOLT_COMMIT('-Am', ?, '--author', ?)", [expect.any(String), AUTHOR]],
    ]);
    const message = onBranch[1].params[0] as string;
    expect(message.split('\n')).toEqual([
      'Enrichment run dead1: partial, 2 rows, 5 enrichments (swept)',
      '',
      'Run-Id: dead1',
      'Plan-Id: plan_1',
      'List-Ref: contacts.csv',
      'Status: partial',
      'Swept: abandoned run branch older than 6h',
    ]);
    const runCommit = fake.hashes[0];

    // Then the same merge finishRun makes, on its own connection to main.
    const onMain = fake.log.filter((statement) => statement.on === 'fire_enrich');
    expect(onMain.map(({ sql, params }) => [sql, params])).toEqual([
      ['START TRANSACTION', []],
      ["CALL DOLT_MERGE('--no-ff', '--no-commit', ?)", ['run/dead1']],
      ['UPDATE enrichment_runs SET commit_hash = ? WHERE id = ?', [runCommit, 'dead1']],
      ["CALL DOLT_COMMIT('-Am', ?, '--author', ?)", [`Merge ${message}`, AUTHOR]],
      ['COMMIT', []],
    ]);

    expect(fake.log.at(-1)).toEqual({ on: 'pool', sql: "CALL DOLT_BRANCH('-D', ?)", params: ['run/dead1'] });
    expect(result).toEqual({
      swept: [
        {
          branch: 'run/dead1',
          runId: 'dead1',
          action: 'merged',
          status: 'partial',
          rows: 2,
          enrichments: 5,
          commitHash: runCommit,
        },
      ],
      failed: [],
    });
    for (const connection of fake.connections) expect(connection.end).toHaveBeenCalled();
  });

  it('carries DOLT_COMMIT_AUTHOR on both the branch commit and the merge', async () => {
    process.env.DOLT_COMMIT_AUTHOR = 'Sweeper <sweeper@example.com>';
    setUp([{ id: 'dead1', ageSeconds: 7 * HOUR }]);
    const { sweepAbandonedRuns } = await loadRuns();

    await sweepAbandonedRuns();

    expect(fake.find(/DOLT_COMMIT/).map((statement) => statement.params[1])).toEqual([
      'Sweeper <sweeper@example.com>',
      'Sweeper <sweeper@example.com>',
    ]);
  });

  it('only deletes the branch of a run main already holds, leaving main unchanged', async () => {
    setUp([{ id: 'merged1', ageSeconds: 30 * HOUR, status: 'completed', onMain: 'abc123' }]);
    const { sweepAbandonedRuns } = await loadRuns();

    const result = await sweepAbandonedRuns();

    expect(fake.find(WRITES)).toEqual([
      { on: 'pool', sql: "CALL DOLT_BRANCH('-D', ?)", params: ['run/merged1'] },
    ]);
    expect(result.swept).toEqual([
      {
        branch: 'run/merged1',
        runId: 'merged1',
        action: 'deleted',
        status: null,
        rows: 0,
        enrichments: 0,
        commitHash: 'abc123',
      },
    ]);
  });

  it('leaves a branch younger than the threshold alone', async () => {
    setUp([{ id: 'live1', ageSeconds: 5 * HOUR }]);
    const { sweepAbandonedRuns } = await loadRuns();

    expect(await sweepAbandonedRuns()).toEqual({ swept: [], failed: [] });
    expect(fake.find(WRITES)).toEqual([]);
    // Its age decides before main is even asked.
    expect(fake.find(/SELECT commit_hash/)).toEqual([]);
  });

  it('takes the threshold from olderThanHours', async () => {
    setUp([{ id: 'run5h', ageSeconds: 5 * HOUR }]);
    const { sweepAbandonedRuns } = await loadRuns();

    const { swept } = await sweepAbandonedRuns({ olderThanHours: 4 });

    expect(swept.map((branch) => branch.branch)).toEqual(['run/run5h']);
    expect(fake.find(/DOLT_COMMIT/, branchDb('run5h'))[0].params[0]).toMatch(/Swept: abandoned run branch older than 4h$/);
    await expect(sweepAbandonedRuns({ olderThanHours: 0 })).rejects.toThrow(/positive number/);
  });

  it('writes nothing on a dry run, and reports what a sweep would do', async () => {
    setUp([
      { id: 'dead1', ageSeconds: 7 * HOUR, contacts: 1, enrichments: 3 },
      { id: 'merged1', ageSeconds: 7 * HOUR, onMain: 'abc123' },
      { id: 'live1', ageSeconds: HOUR },
    ]);
    const { sweepAbandonedRuns } = await loadRuns();

    const { swept, failed } = await sweepAbandonedRuns({ dryRun: true });

    expect(fake.find(WRITES)).toEqual([]);
    expect(fake.find(/START TRANSACTION/)).toEqual([]);
    expect(failed).toEqual([]);
    expect(swept.map(({ branch, action, status, rows, enrichments }) => ({ branch, action, status, rows, enrichments }))).toEqual([
      { branch: 'run/dead1', action: 'merged', status: 'partial', rows: 1, enrichments: 3 },
      { branch: 'run/merged1', action: 'deleted', status: null, rows: 0, enrichments: 0 },
    ]);
  });

  it('returns nothing when no run branch exists', async () => {
    setUp([]);
    const { sweepAbandonedRuns } = await loadRuns();

    expect(await sweepAbandonedRuns()).toEqual({ swept: [], failed: [] });
    expect(fake.find(WRITES)).toEqual([]);
  });

  it('merges a branch finishRun committed but could not merge, keeping its status', async () => {
    setUp([{ id: 'unmerged1', ageSeconds: 7 * HOUR, status: 'completed' }]);
    fake.respond(/DOLT_COMMIT/, ({ on }: Statement) => {
      if (on === branchDb('unmerged1')) throw new Error('nothing to commit');
      return [[{ hash: 'mergecommit' }]];
    });
    fake.respond(/DOLT_HASHOF/, () => [{ hash: 'branchhead' }]);
    const { sweepAbandonedRuns } = await loadRuns();

    const { swept } = await sweepAbandonedRuns();

    // The status update only touches a row still `running`.
    expect(fake.find(/SET status/)[0].sql).toMatch(/AND status = 'running'$/);
    expect(fake.find(/SET commit_hash/)[0].params).toEqual(['branchhead', 'unmerged1']);
    expect(fake.find(/DOLT_COMMIT/, 'fire_enrich')[0].params[0]).toMatch(/^Merge Enrichment run unmerged1: completed/);
    expect(swept[0]).toMatchObject({ action: 'merged', status: 'completed', commitHash: 'branchhead' });
  });

  it('reports a branch that fails and goes on with the next', async () => {
    setUp([
      { id: 'bad1', ageSeconds: 7 * HOUR },
      { id: 'dead2', ageSeconds: 7 * HOUR },
    ]);
    fake.respond(/DOLT_MERGE/, ({ params }: Statement) => {
      if (params[0] === 'run/bad1') return [[{ hash: '', fast_forward: 0, conflicts: 1 }]];
      return [[{ hash: '', fast_forward: 0, conflicts: 0, message: 'merge successful' }]];
    });
    const { sweepAbandonedRuns } = await loadRuns();

    const { swept, failed } = await sweepAbandonedRuns();

    expect(failed).toEqual([{ branch: 'run/bad1', error: 'Merging run/bad1 into main conflicted' }]);
    expect(swept.map((branch) => branch.branch)).toEqual(['run/dead2']);
    // The failed branch is kept for another sweep or a look by hand.
    expect(fake.find(/DOLT_BRANCH/).map((statement) => statement.params)).toEqual([['run/dead2']]);
  });

  it('leaves a branch with no run row in place', async () => {
    setUp([{ id: 'empty1', ageSeconds: 0, noRow: true }]);
    const { sweepAbandonedRuns } = await loadRuns();

    expect(await sweepAbandonedRuns()).toEqual({ swept: [], failed: [] });
    expect(fake.find(WRITES)).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/run\/empty1 has no run row/));
  });
});
