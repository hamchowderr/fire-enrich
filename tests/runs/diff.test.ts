import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureDolt, installFakeDolt, isolateDoltEnv, type Statement } from './fake-dolt';

/**
 * Run diffs (`diffRuns`, `previousRunFor` in `lib/runs.ts`) and
 * `GET /api/runs/:id/diff` over a fake Dolt. What is asserted: the SQL and
 * its parameters (each run read `AS OF` its own commit, filtered to its own
 * `run_id`), the join on `(contact_email, field)` (added, changed and removed
 * values, unchanged ones left out), the predecessor lookup, and the route's
 * status codes and bodies.
 */
const { createPool, createConnection } = vi.hoisted(() => ({ createPool: vi.fn(), createConnection: vi.fn() }));

vi.mock('mysql2/promise', () => ({ default: { createPool, createConnection } }));

const fake = installFakeDolt(createPool, createConnection);
let restoreEnv: () => void;

const run = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  plan_id: null,
  list_ref: 'emails:sha256:0123456789abcdef (2 rows)',
  status: 'completed',
  started_at: id === 'run_a' ? '2026-09-01 10:00:00' : '2026-09-02 10:00:00',
  finished_at: id === 'run_a' ? '2026-09-01 10:05:00' : '2026-09-02 10:05:00',
  commit_hash: `hash_${id}`,
  ...overrides,
});

/** Runs on `main`'s head, by id. */
let runs: Record<string, ReturnType<typeof run>>;
/** Enrichment rows per commit hash, as `AS OF <hash>` would return them. */
let enrichmentsAt: Record<string, Array<Record<string, unknown>>>;
/** The run `previousRunFor`'s query answers. */
let previous: ReturnType<typeof run> | null;

function answerFromTables() {
  fake.respond(/FROM enrichment_runs WHERE id = \?/, ({ params }: Statement) =>
    runs[params[0] as string] ? [runs[params[0] as string]] : []
  );
  fake.respond(/FROM enrichment_runs\s+WHERE list_ref = \?/, () => (previous ? [previous] : []));
  fake.respond(/FROM enrichments AS OF \? WHERE run_id = \?/, ({ params }: Statement) =>
    (enrichmentsAt[params[0] as string] ?? []).filter((row) => row.run_id === params[1])
  );
  fake.respond(/FROM enrichments AS OF \? e\s+LEFT JOIN evidence AS OF \? v/, ({ params }: Statement) =>
    (enrichmentsAt[params[0] as string] ?? []).filter((row) => row.run_id === params[2])
  );
}

async function loadRuns() {
  vi.resetModules();
  return import('@/lib/runs');
}

async function getDiff(id: string, query = '') {
  vi.resetModules();
  const { GET } = await import('@/app/api/runs/[id]/diff/route');
  const response = await GET(new NextRequest(`http://127.0.0.1/api/runs/${id}/diff${query}`), {
    params: Promise.resolve({ id }),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  restoreEnv = isolateDoltEnv();
  configureDolt();
  fake.reset();
  runs = { run_a: run('run_a'), run_b: run('run_b') };
  previous = runs.run_a;
  enrichmentsAt = {
    // Run A: x's headline and y's headline, and y's funding, which run B drops.
    hash_run_a: [
      { id: 'a1', run_id: 'run_a', contact_email: 'x@example.com', field: 'headline', value: 'Old headline' },
      { id: 'a2', run_id: 'run_a', contact_email: 'y@example.com', field: 'headline', value: 'Same headline' },
      { id: 'a3', run_id: 'run_a', contact_email: 'y@example.com', field: 'funding', value: 'Seed' },
    ],
    // Run B, joined to its evidence: x's headline changed (two sources), y's
    // headline unchanged, y's employees added, y's funding gone. The run's
    // own commit also still holds run A's rows, which the run_id filter drops.
    hash_run_b: [
      { id: 'a1', run_id: 'run_a', contact_email: 'x@example.com', field: 'headline', value: 'Old headline', confidence: '0.900', url: 'https://old.example/', quote: null },
      { id: 'b1', run_id: 'run_b', contact_email: 'X@Example.com', field: 'headline', value: 'New headline', confidence: '0.850', url: 'https://new.example/', quote: 'New headline' },
      { id: 'b1', run_id: 'run_b', contact_email: 'X@Example.com', field: 'headline', value: 'New headline', confidence: '0.850', url: 'https://new.example/about', quote: null },
      { id: 'b2', run_id: 'run_b', contact_email: 'y@example.com', field: 'headline', value: 'Same headline', confidence: '0.900', url: 'https://y.example/', quote: null },
      { id: 'b3', run_id: 'run_b', contact_email: 'y@example.com', field: 'employees', value: '40', confidence: '0.700', url: null, quote: null },
    ],
  };
  answerFromTables();
});

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

describe('diffRuns', () => {
  it('reads each run AS OF its own commit, filtered to its run_id, with evidence AS OF the later commit', async () => {
    const { diffRuns } = await loadRuns();

    await diffRuns('run_a', 'run_b');

    expect(fake.log.map(({ on, sql, params }) => ({ on, sql: sql.replace(/\s+/g, ' ').trim(), params }))).toEqual([
      {
        on: 'pool',
        sql: 'SELECT id, plan_id, list_ref, status, started_at, finished_at, commit_hash FROM enrichment_runs WHERE id = ?',
        params: ['run_a'],
      },
      {
        on: 'pool',
        sql: 'SELECT id, plan_id, list_ref, status, started_at, finished_at, commit_hash FROM enrichment_runs WHERE id = ?',
        params: ['run_b'],
      },
      {
        on: 'pool',
        sql: 'SELECT id, contact_email, field, value FROM enrichments AS OF ? WHERE run_id = ? ORDER BY id',
        params: ['hash_run_a', 'run_a'],
      },
      {
        on: 'pool',
        sql:
          'SELECT e.id, e.contact_email, e.field, e.value, e.confidence, v.url, v.quote FROM enrichments AS OF ? e ' +
          'LEFT JOIN evidence AS OF ? v ON v.enrichment_id = e.id WHERE e.run_id = ? ORDER BY e.id, v.id',
        params: ['hash_run_b', 'hash_run_b', 'run_b'],
      },
    ]);
    // Nothing is written, and dolt_diff is not used.
    expect(fake.find(/INSERT|UPDATE|DOLT_COMMIT|dolt_diff/i)).toEqual([]);
  });

  it('lists added, changed and removed values and leaves unchanged ones out', async () => {
    const { diffRuns } = await loadRuns();

    const { from, to, changes } = await diffRuns('run_a', 'run_b');

    expect(from).toMatchObject({ id: 'run_a', commitHash: 'hash_run_a' });
    expect(to).toMatchObject({ id: 'run_b', commitHash: 'hash_run_b', listRef: 'emails:sha256:0123456789abcdef (2 rows)' });
    expect(changes).toEqual([
      {
        // Matched to run A's `x@example.com` although run B wrote it in capitals.
        contactEmail: 'X@Example.com',
        field: 'headline',
        change: 'changed',
        from: 'Old headline',
        to: 'New headline',
        confidence: 0.85,
        sources: [
          { url: 'https://new.example/', quote: 'New headline' },
          { url: 'https://new.example/about', quote: null },
        ],
      },
      {
        contactEmail: 'y@example.com',
        field: 'employees',
        change: 'added',
        from: null,
        to: '40',
        confidence: 0.7,
        sources: [],
      },
      {
        contactEmail: 'y@example.com',
        field: 'funding',
        change: 'removed',
        from: 'Seed',
        to: null,
        confidence: null,
        sources: [],
      },
    ]);
  });

  it('answers no changes for two runs with the same values', async () => {
    enrichmentsAt.hash_run_b = enrichmentsAt.hash_run_a.map((row) => ({
      ...row,
      id: `b_${row.id}`,
      run_id: 'run_b',
      confidence: '0.500',
      url: 'https://a-different-source.example/',
      quote: null,
    }));
    const { diffRuns } = await loadRuns();

    expect((await diffRuns('run_a', 'run_b')).changes).toEqual([]);
  });

  it('treats a value found after nothing was found as a change', async () => {
    enrichmentsAt.hash_run_a[0].value = null;
    const { diffRuns } = await loadRuns();

    const { changes } = await diffRuns('run_a', 'run_b');

    expect(changes[0]).toMatchObject({ field: 'headline', change: 'changed', from: null, to: 'New headline' });
  });

  it('throws RunNotFoundError naming the unknown run, on either side, before reading any values', async () => {
    const { diffRuns, RunNotFoundError } = await loadRuns();

    await expect(diffRuns('missing', 'run_b')).rejects.toMatchObject({ name: 'RunNotFoundError', runId: 'missing' });
    await expect(diffRuns('run_a', 'missing')).rejects.toBeInstanceOf(RunNotFoundError);
    expect(fake.find(/FROM enrichments/)).toEqual([]);
  });

  it('throws RunsNotComparableError for the same run twice or runs of different lists', async () => {
    runs.run_c = run('run_c', { list_ref: 'contacts.csv' });
    const { diffRuns } = await loadRuns();

    await expect(diffRuns('run_b', 'run_b')).rejects.toMatchObject({ name: 'RunsNotComparableError' });
    await expect(diffRuns('run_c', 'run_b')).rejects.toMatchObject({
      name: 'RunsNotComparableError',
      message: 'Runs run_c and run_b are of different lists',
    });
    expect(fake.find(/FROM enrichments/)).toEqual([]);
  });

  it('diffs a partial run by id: only the default baseline is limited to completed runs', async () => {
    runs.run_a = run('run_a', { status: 'partial' });
    const { diffRuns } = await loadRuns();

    expect((await diffRuns('run_a', 'run_b')).changes).toHaveLength(3);
  });

  it('throws RunNotCommittedError for a run with no commit', async () => {
    runs.run_b = run('run_b', { commit_hash: null, status: 'running' });
    const { diffRuns } = await loadRuns();

    await expect(diffRuns('run_a', 'run_b')).rejects.toMatchObject({ name: 'RunNotCommittedError', runId: 'run_b' });
    expect(fake.find(/FROM enrichments/)).toEqual([]);
  });
});

describe('previousRunFor', () => {
  it('asks for the latest earlier committed, completed run with the same list_ref', async () => {
    const { previousRunFor } = await loadRuns();

    const found = await previousRunFor('run_b');

    expect(found).toEqual({
      id: 'run_a',
      planId: null,
      listRef: 'emails:sha256:0123456789abcdef (2 rows)',
      status: 'completed',
      startedAt: '2026-09-01 10:00:00',
      finishedAt: '2026-09-01 10:05:00',
      commitHash: 'hash_run_a',
    });
    const [lookup] = fake.find(/WHERE list_ref = \?/);
    expect(lookup.sql.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT id, plan_id, list_ref, status, started_at, finished_at, commit_hash FROM enrichment_runs ' +
        'WHERE list_ref = ? AND id <> ? AND status = ? AND commit_hash IS NOT NULL ' +
        'AND (started_at < ? OR (started_at = ? AND id < ?)) ORDER BY started_at DESC, id DESC LIMIT 1'
    );
    // Only a completed run is a default baseline; partial and failed runs are
    // reachable by id (`?against=`).
    expect(lookup.params).toEqual([
      'emails:sha256:0123456789abcdef (2 rows)',
      'run_b',
      'completed',
      '2026-09-02 10:00:00',
      '2026-09-02 10:00:00',
      'run_b',
    ]);
  });

  it('answers null for the first run of a list', async () => {
    previous = null;
    const { previousRunFor } = await loadRuns();

    expect(await previousRunFor('run_a')).toBeNull();
  });

  it('throws RunNotFoundError for an unknown run', async () => {
    const { previousRunFor } = await loadRuns();

    await expect(previousRunFor('missing')).rejects.toMatchObject({ name: 'RunNotFoundError', runId: 'missing' });
    expect(fake.find(/WHERE list_ref/)).toEqual([]);
  });
});

describe('GET /api/runs/:id/diff', () => {
  it('answers 503 when Dolt is not configured, without touching the database', async () => {
    delete process.env.DOLT_HOST;

    const { status, body } = await getDiff('run_b');

    expect(status).toBe(503);
    expect(body.error).toMatch(/Run diffs need a Dolt database/);
    expect(fake.log).toEqual([]);
  });

  it('answers 404 for an unknown run', async () => {
    const { status, body } = await getDiff('missing');

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'No run with id missing' });
  });

  it('answers 404 for an unknown `against` run', async () => {
    const { status, body } = await getDiff('run_b', '?against=missing');

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'No run with id missing' });
  });

  it('answers 400 when `against` is the run itself', async () => {
    const { status, body } = await getDiff('run_b', '?against=run_b');

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Run run_b cannot be diffed against itself' });
  });

  it('answers 400 when `against` is a run of a different list', async () => {
    runs.run_c = run('run_c', { list_ref: 'contacts.csv' });

    const { status, body } = await getDiff('run_b', '?against=run_c');

    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Runs run_c and run_b are of different lists' });
    expect(fake.find(/FROM enrichments/)).toEqual([]);
  });

  it('answers 409 for a run row with no commit', async () => {
    runs.run_b = run('run_b', { commit_hash: null });

    const { status } = await getDiff('run_b', '?against=run_a');

    expect(status).toBe(409);
  });

  it('answers predecessor null and no changes for the first run of a list', async () => {
    previous = null;

    const { status, body } = await getDiff('run_a');

    expect(status).toBe(200);
    expect(body).toMatchObject({ from: null, to: { id: 'run_a' }, predecessor: null, changes: [] });
  });

  it('answers the predecessor and no changes when nothing changed', async () => {
    enrichmentsAt.hash_run_b = enrichmentsAt.hash_run_a.map((row) => ({ ...row, id: `b_${row.id}`, run_id: 'run_b', url: null }));

    const { status, body } = await getDiff('run_b');

    expect(status).toBe(200);
    expect(body).toMatchObject({ from: { id: 'run_a' }, to: { id: 'run_b' }, predecessor: 'run_a', changes: [] });
  });

  it('diffs against the previous run of the same list by default', async () => {
    const { status, body } = await getDiff('run_b');

    expect(status).toBe(200);
    expect(body.predecessor).toBe('run_a');
    expect(body.changes.map((change: { field: string; change: string }) => `${change.field}:${change.change}`)).toEqual([
      'headline:changed',
      'employees:added',
      'funding:removed',
    ]);
    expect(body.changes[0].sources[0]).toEqual({ url: 'https://new.example/', quote: 'New headline' });
  });

  it('diffs against the run named by `against`, without looking up a predecessor', async () => {
    const { status, body } = await getDiff('run_b', '?against=run_a');

    expect(status).toBe(200);
    expect(body.predecessor).toBe('run_a');
    expect(body.changes).toHaveLength(3);
    expect(fake.find(/WHERE list_ref/)).toEqual([]);
  });
});
