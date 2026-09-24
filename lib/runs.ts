/**
 * Enrichment runs in Dolt: one run row, its enrichments and their evidence,
 * and one Dolt commit that holds exactly that run.
 *
 * ## One branch per run
 *
 * `DOLT_COMMIT('-Am')` commits the whole working set of the branch it runs on.
 * If every run wrote to `main`, two runs in flight at once would share that
 * working set: the first to finish would commit both runs' rows, and the second
 * would find nothing left to commit and get no hash. So each run writes on its
 * own branch, `run/<id>`:
 *
 * 1. {@link startRun} branches `run/<id>` off `main`'s head and opens a
 *    dedicated connection on the revision database `<db>/run/<id>`. Every
 *    write of the run goes through that connection, into that branch's
 *    working set, which no other run touches.
 * 2. {@link recordRow} writes one row's enrichments and evidence as it
 *    finishes, in one SQL transaction on the run's connection. Nothing waits
 *    for the end of the run, so a cancelled run still commits what finished,
 *    and a crashed process leaves its rows in the branch's working set (Dolt
 *    persists working sets) rather than losing them.
 * 3. {@link finishRun} sets the terminal status and `finished_at`, commits
 *    the branch (the run's commit: its diff is exactly this run's rows), then
 *    merges the branch into `main` with `--no-ff --no-commit`, sets
 *    `commit_hash` to the run's commit, and commits the merge. The merged
 *    branch is then deleted; its commit stays reachable as the merge's second
 *    parent, so `AS OF '<commit_hash>'` keeps working.
 *
 * `commit_hash` names the branch commit, not the merge: a commit cannot
 * contain its own hash, so the hash is written by the merge that brings the
 * run into `main`. On `main` each run is therefore one merge commit (first
 * parent history: one commit per run, whose diff is that run plus its
 * `commit_hash`), with the run's own commit as its second parent.
 *
 * Merges into `main` run one at a time in this process ({@link withMainLock}),
 * each inside a SQL transaction. That keeps this process's merges from
 * interleaving with each other. It does not isolate a merge from other
 * writes to `main` (see Limits).
 *
 * ## Limits
 *
 * - A run's merge commit can carry someone else's uncommitted change.
 *   `DOLT_MERGE('--no-commit')` stages the merge on top of `main`'s working
 *   set, and `DOLT_COMMIT('-Am')` commits that whole working set. A write on
 *   `main` that is committed as SQL but not yet as a Dolt commit (a profile
 *   write between its INSERT and its `DOLT_COMMIT`, from this process or
 *   another) is swept into the run's merge commit. Nothing is lost, but that
 *   commit's diff is then more than the run.
 * - The merge lock is per process. Merges from several app instances can
 *   overlap. Dolt merges concurrent transactions cell by cell, and runs
 *   write disjoint rows (fresh nanoid keys), so overlapping merges normally
 *   both commit. A transaction that does collide fails with Dolt's
 *   "serialization failure: this transaction conflicts with a committed
 *   transaction from another client, try restarting transaction", and the
 *   merge is retried ({@link MERGE_ATTEMPTS}).
 * - A merge whose commit landed but whose acknowledgement was lost is
 *   retried like any other. The retry finds the branch already merged and
 *   confirms it from `commit_hash` on `main` ({@link confirmMerged}).
 * - A run in flight is only visible on its branch
 *   (`SELECT * FROM enrichment_runs AS OF 'run/<id>'`, or `dolt_branches`),
 *   not on `main`, until it finishes.
 * - A process that dies mid-run leaves `run/<id>` behind with its rows
 *   uncommitted in the branch's working set, until {@link sweepAbandonedRuns}
 *   (`npm run db:sweep-runs`) finds the branch older than its threshold and
 *   merges what finished as a `partial` run. Nothing runs the sweeper on a
 *   schedule yet.
 * - One extra connection per run in flight, outside the pool.
 * - Dolt refuses a merge into `main` while `main`'s working set holds
 *   uncommitted changes to a table the merge touches ("local changes would be
 *   stomped by merge"). Writes to the run tables only ever arrive by merge, and
 *   profile writes commit at once, so this only happens after a manual,
 *   uncommitted edit of those tables on `main`; the run then stays on its
 *   branch, committed but unmerged.
 *
 * ## Lists and re-runs
 *
 * `list_ref` names the contact list a run covered, and two runs are runs of
 * the same list exactly when their `list_ref`s are equal. The formats are:
 *
 * - `emails:sha256:<16 hex> (N rows)`: a CSV upload with no name given. The
 *   hash is over the lowercased, trimmed emails in order ({@link listRefFor}),
 *   so the same file uploaded again under any name is the same list.
 * - the caller's own `listRef` (for example a CSV file name), as sent.
 * - `crm:list:<id>` and `crm:tag:<id>`: reserved for a CRM import, a list or a
 *   tag in the CRM by its id.
 *
 * {@link previousRunFor} finds the run before a given one on the same list,
 * and {@link diffRuns} lists the values that differ between two runs.
 *
 * A diff cannot come from `dolt_diff`: each run inserts fresh enrichment ids,
 * so between two runs every value is a deleted row and an inserted row, never
 * a modified one. Instead each run's enrichments are read `AS OF` its own
 * commit (`commit_hash`) and matched on `(contact_email, field)`. The run's
 * own row carries `commit_hash` NULL at that commit (the hash is written by
 * the merge), so run rows are always read from `main`'s head.
 */
import { createHash } from 'node:crypto';

import type mysql from 'mysql2/promise';
import { nanoid } from 'nanoid';

import { connect, isNothingToCommit, query, readCommitHash, select } from '@/lib/dolt';
import type { CSVRow, EnrichmentResult } from '@/lib/types';

/** Identity on run commits when `DOLT_COMMIT_AUTHOR` is unset or malformed. */
const DEFAULT_COMMIT_AUTHOR = 'Fire Enrich <fire-enrich@localhost>';

/** How often a merge into `main` is tried before the run is reported unmerged. */
const MERGE_ATTEMPTS = 3;

/** `list_ref` is VARCHAR(512). */
const LIST_REF_MAX = 512;

export type RunStatus = 'running' | 'completed' | 'partial' | 'failed';

/** Terminal statuses: `partial` is a cancelled run, `failed` a session error. */
export type FinishStatus = Exclude<RunStatus, 'running'>;

/** Field name → the strategy of the plan group that researched it. */
export type FieldStrategies = Readonly<Record<string, string | undefined>>;

/**
 * `Name <email>` from `DOLT_COMMIT_AUTHOR`, or {@link DEFAULT_COMMIT_AUTHOR}.
 * Dolt rejects an author without the `<email>` part, so a malformed value
 * falls back instead of failing every run's commit.
 */
function commitAuthor(): string {
  const configured = process.env.DOLT_COMMIT_AUTHOR?.trim();
  return configured && /^[^<>]+ <[^<>\s]+>$/.test(configured) ? configured : DEFAULT_COMMIT_AUTHOR;
}

/**
 * The `list_ref` for a request: the caller's own reference when it sent one
 * (a CSV file name, a stored list id), else a fingerprint of the emails, which
 * identifies the same list again whatever it was called.
 */
export function listRefFor(given: unknown, rows: readonly CSVRow[], emailColumn: string): string {
  if (typeof given === 'string' && given.trim()) return given.trim().slice(0, LIST_REF_MAX);

  const emails = rows.map((row) => String(row[emailColumn] ?? '').trim().toLowerCase());
  const digest = createHash('sha256').update(emails.join('\n')).digest('hex').slice(0, 16);
  return `emails:sha256:${digest} (${rows.length} row${rows.length === 1 ? '' : 's'})`;
}

/** A run in flight: its branch, the connection on it, and its write queue. */
interface ActiveRun {
  id: string;
  branch: string;
  planId: string | null;
  listRef: string;
  connection: mysql.Connection;
  /** Tail of the run's writes; each write starts when the previous one settles. */
  writes: Promise<unknown>;
  rows: number;
  enrichments: number;
  evidence: number;
}

/**
 * Runs in flight, on `globalThis` for the reason `plan-cache.ts` gives:
 * route modules are re-evaluated on edit in dev, and the start and finish of a
 * run must see the same map.
 */
const globalForRuns = globalThis as typeof globalThis & {
  __fireEnrichRuns?: Map<string, ActiveRun>;
  __fireEnrichMainLock?: Promise<unknown>;
};

const activeRuns: Map<string, ActiveRun> = (globalForRuns.__fireEnrichRuns ??= new Map());

function activeRun(runId: string): ActiveRun {
  const run = activeRuns.get(runId);
  if (!run) throw new Error(`Run ${runId} is not in progress in this process`);
  return run;
}

/**
 * Run `task` once every earlier task given to this lock has settled. Guards
 * the merges into `main`, which share `main`'s working set.
 */
function withMainLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = globalForRuns.__fireEnrichMainLock ?? Promise.resolve();
  const next = previous.then(task, task);
  globalForRuns.__fireEnrichMainLock = next.catch(() => undefined);
  return next;
}

/** MySQL's "foreign key: parent row missing" (ER_NO_REFERENCED_ROW_2). */
function isMissingParent(error: unknown): boolean {
  const { errno, code } = (error ?? {}) as { errno?: number; code?: string };
  return errno === 1452 || code === 'ER_NO_REFERENCED_ROW_2';
}

/**
 * Start a run: branch `run/<id>` off `main`, open a connection on it, and
 * insert the run row with status `running`.
 *
 * `planId` is null for a plan that has no saved row (the planner fallback). A
 * plan id whose row is not on `main`'s head (an uncommitted save) would fail
 * the foreign key; the run is then recorded without it rather than not at all.
 */
export async function startRun({
  planId,
  listRef,
}: {
  planId?: string | null;
  listRef: string;
}): Promise<string> {
  const id = nanoid();
  const branch = `run/${id}`;

  await query('CALL DOLT_BRANCH(?)', [branch]);

  let connection: mysql.Connection | null = null;
  try {
    connection = await connect(branch);
    let recordedPlanId = planId ?? null;
    const insert = 'INSERT INTO enrichment_runs (id, plan_id, list_ref, status) VALUES (?, ?, ?, ?)';

    try {
      await connection.query(insert, [id, recordedPlanId, listRef.slice(0, LIST_REF_MAX), 'running']);
    } catch (error) {
      if (!recordedPlanId || !isMissingParent(error)) throw error;
      console.warn(`[RUNS] Plan ${recordedPlanId} is not committed on main; run ${id} is recorded without it`);
      recordedPlanId = null;
      await connection.query(insert, [id, null, listRef.slice(0, LIST_REF_MAX), 'running']);
    }

    activeRuns.set(id, {
      id,
      branch,
      planId: recordedPlanId,
      listRef,
      connection,
      writes: Promise.resolve(),
      rows: 0,
      enrichments: 0,
      evidence: 0,
    });
    return id;
  } catch (error) {
    await connection?.end().catch(() => undefined);
    await query("CALL DOLT_BRANCH('-D', ?)", [branch]).catch(() => undefined);
    throw error;
  }
}

/** A value as stored in `enrichments.value`: text, with arrays as JSON. */
function storedValue(value: EnrichmentResult['value'] | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? JSON.stringify(value) : String(value);
}

/** 0..1 at `DECIMAL(4, 3)` precision; anything else is NULL, not a guess. */
function storedConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}

/**
 * The evidence the UI shows for one enrichment: the corroborating quotes with
 * their own confidence, or, when a result carries none, its source contexts at
 * the field's confidence.
 */
function evidenceOf(enrichment: EnrichmentResult): Array<{ url: string; quote: string | null; confidence: number | null }> {
  const corroborating = enrichment.corroboration?.evidence ?? [];
  if (corroborating.length > 0) {
    return corroborating.map((item) => ({
      url: item.source_url,
      quote: item.exact_text || null,
      confidence: storedConfidence(item.confidence),
    }));
  }

  return (enrichment.sourceContext ?? []).map((context) => ({
    url: context.url,
    quote: context.snippet || null,
    confidence: storedConfidence(enrichment.confidence),
  }));
}

/**
 * Record one finished row: an `enrichments` row per field and an `evidence`
 * row per quote, in one SQL transaction on the run's branch.
 *
 * Writes of one run are queued, so rows finishing together are written one
 * after the other and {@link finishRun} waits for every one of them. Resolves
 * to the number of enrichments written.
 */
export function recordRow(
  runId: string,
  email: string,
  enrichments: Readonly<Record<string, EnrichmentResult>>,
  strategies: FieldStrategies = {}
): Promise<number> {
  const run = activeRun(runId);

  const write = run.writes.then(async () => {
    const enrichmentRows: unknown[][] = [];
    const evidenceRows: unknown[][] = [];

    for (const [name, enrichment] of Object.entries(enrichments)) {
      const enrichmentId = nanoid();
      const field = enrichment.field || name;
      enrichmentRows.push([
        enrichmentId,
        runId,
        email,
        field,
        storedValue(enrichment.value),
        storedConfidence(enrichment.confidence),
        strategies[field] ?? strategies[name] ?? null,
      ]);
      for (const item of evidenceOf(enrichment)) {
        evidenceRows.push([nanoid(), enrichmentId, item.url, item.quote, item.confidence]);
      }
    }

    run.rows += 1;
    if (enrichmentRows.length === 0) return 0;

    const { connection } = run;
    await connection.query('START TRANSACTION');
    try {
      await connection.query(
        'INSERT INTO enrichments (id, run_id, contact_email, field, value, confidence, strategy) VALUES ?',
        [enrichmentRows]
      );
      if (evidenceRows.length > 0) {
        await connection.query('INSERT INTO evidence (id, enrichment_id, url, quote, confidence) VALUES ?', [
          evidenceRows,
        ]);
      }
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    run.enrichments += enrichmentRows.length;
    run.evidence += evidenceRows.length;
    return enrichmentRows.length;
  });

  run.writes = write.catch(() => undefined);
  return write;
}

/**
 * Stop recording a run without committing it: close its connection and forget
 * it. The branch and whatever reached its working set are left for inspection.
 */
export async function abandonRun(runId: string): Promise<void> {
  const run = activeRuns.get(runId);
  if (!run) return;
  activeRuns.delete(runId);
  await run.writes;
  await run.connection.end().catch(() => undefined);
}

/** What a run's commit message says about it. */
type RunTally = Pick<ActiveRun, 'id' | 'planId' | 'listRef' | 'rows' | 'enrichments'>;

/** A run's branch, as the merge into `main` needs it. */
type RunBranch = Pick<ActiveRun, 'id' | 'branch'>;

/**
 * Commit message for a run: a summary line, then trailers `dolt_log` can be
 * filtered on. `swept` names the reason a sweep, not the run, finished it.
 */
function commitMessage(run: RunTally, status: FinishStatus, swept?: string): string {
  return [
    `Enrichment run ${run.id}: ${status}, ${run.rows} row${run.rows === 1 ? '' : 's'}, ${run.enrichments} enrichment${run.enrichments === 1 ? '' : 's'}${swept ? ' (swept)' : ''}`,
    '',
    `Run-Id: ${run.id}`,
    `Plan-Id: ${run.planId ?? 'none'}`,
    `List-Ref: ${run.listRef.replace(/\s+/g, ' ')}`,
    `Status: ${status}`,
    ...(swept ? [`Swept: ${swept}`] : []),
  ].join('\n');
}

/**
 * A transaction that lost a race with another client's write to `main`,
 * worth retrying. Dolt 2.1 words it "serialization failure: this transaction
 * conflicts with a committed transaction from another client, try restarting
 * transaction."; MySQL's deadlock error also ends in "try restarting
 * transaction".
 */
function isRetryableMergeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /serialization failure|try restarting transaction/i.test(message);
}

/** The first row of a `DOLT_MERGE` result, whichever shape the driver returns. */
function mergeRow(result: unknown): { conflicts?: unknown; message?: unknown } | undefined {
  const first = Array.isArray(result) ? result[0] : result;
  return (Array.isArray(first) ? first[0] : first) as { conflicts?: unknown; message?: unknown } | undefined;
}

/**
 * Whether `DOLT_MERGE` found the branch already in `main`. Dolt 2.1.8
 * answers a clean, empty merge: "cannot fast forward from a to b. a is ahead
 * of b already". Any other wording still ends in "nothing to commit" at
 * `DOLT_COMMIT`, which is handled the same way.
 */
function isAlreadyMerged(result: unknown): boolean {
  return /is ahead of/i.test(String(mergeRow(result)?.message ?? ''));
}

/**
 * A merge that found nothing to merge: an earlier attempt committed, and only
 * its acknowledgement was lost. The run is recorded if `main`'s run row
 * carries this run's commit; anything else is an error, not a success.
 */
async function confirmMerged(connection: mysql.Connection, run: RunBranch, runCommit: string): Promise<null> {
  const [rows] = await connection.query('SELECT commit_hash FROM enrichment_runs WHERE id = ?', [run.id]);
  const onMain = (rows as Array<{ commit_hash?: unknown }>)[0]?.commit_hash;
  if (onMain === runCommit) return null;
  throw new Error(`${run.branch} is already in main, but main's run row does not carry its commit ${runCommit}`);
}

/**
 * Merge the run's branch into `main` and record its commit hash there, as one
 * merge commit. Returns the merge commit's hash, or null when the branch was
 * already merged by an earlier attempt.
 */
async function mergeIntoMain(run: RunBranch, runCommit: string, message: string, author: string): Promise<string | null> {
  const connection = await connect();
  try {
    await connection.query('START TRANSACTION');
    try {
      const [merge] = await connection.query("CALL DOLT_MERGE('--no-ff', '--no-commit', ?)", [run.branch]);
      if (Number(mergeRow(merge)?.conflicts ?? 0) > 0) throw new Error(`Merging ${run.branch} into main conflicted`);

      if (!isAlreadyMerged(merge)) {
        await connection.query('UPDATE enrichment_runs SET commit_hash = ? WHERE id = ?', [runCommit, run.id]);
        const committed = await connection
          .query("CALL DOLT_COMMIT('-Am', ?, '--author', ?)", [`Merge ${message}`, author])
          .then(([result]) => result, (error: unknown) => {
            // A no-op merge that Dolt did not word as one.
            if (isNothingToCommit(error)) return null;
            throw error;
          });
        if (committed !== null) {
          await connection.query('COMMIT');
          return readCommitHash(committed);
        }
      }
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    // Already merged. Read outside the transaction, so the row is `main`'s
    // committed state.
    await connection.query('ROLLBACK');
    return confirmMerged(connection, run, runCommit);
  } finally {
    await connection.end().catch(() => undefined);
  }
}

/**
 * {@link mergeIntoMain} under this process's merge lock, retried on a lost
 * race with another client's write ({@link MERGE_ATTEMPTS}).
 */
function mergeWithRetry(run: RunBranch, runCommit: string, message: string, author: string): Promise<void> {
  return withMainLock(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await mergeIntoMain(run, runCommit, message, author);
        return;
      } catch (error) {
        if (attempt >= MERGE_ATTEMPTS || !isRetryableMergeError(error)) throw error;
      }
    }
  });
}

/**
 * Finish a run: wait for its writes, set its terminal status and
 * `finished_at`, commit the branch, and merge it into `main` with the commit's
 * hash in `commit_hash`. Resolves to the run's commit hash.
 */
export async function finishRun(runId: string, status: FinishStatus): Promise<string | null> {
  const run = activeRun(runId);
  activeRuns.delete(runId);

  const author = commitAuthor();
  let message = '';
  let runCommit: string | null;

  try {
    await run.writes;
    // After the writes, so the summary counts every row that landed.
    message = commitMessage(run, status);
    await run.connection.query(
      'UPDATE enrichment_runs SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, run.id]
    );
    const [committed] = await run.connection.query("CALL DOLT_COMMIT('-Am', ?, '--author', ?)", [message, author]);
    runCommit = readCommitHash(committed);
  } finally {
    await run.connection.end().catch(() => undefined);
  }

  if (!runCommit) throw new Error(`Dolt returned no hash for run ${run.id}'s commit`);

  await mergeWithRetry(run, runCommit, message, author);

  // Merged, so the branch only duplicates what `main` now holds. A failure
  // here leaves a stale pointer, not lost data.
  await query("CALL DOLT_BRANCH('-d', ?)", [run.branch]).catch((error) => {
    console.warn(`[RUNS] Could not delete ${run.branch}: ${error instanceof Error ? error.message : error}`);
  });

  return runCommit;
}

/** How long a run branch sits untouched before the sweeper takes it as abandoned. */
export const DEFAULT_SWEEP_HOURS = 6;

/** What the sweeper did, or in a dry run would do, with one abandoned branch. */
export interface SweptBranch {
  branch: string;
  runId: string;
  /**
   * `merged`: the branch's rows were committed and merged into `main` as a
   * `partial` run. `deleted`: `main` already held the run, so only the branch
   * went.
   */
  action: 'merged' | 'deleted';
  /**
   * The run's status on `main` after the sweep: `partial` for a run that was
   * still `running`, else the status `finishRun` committed before its merge
   * failed. Null for `deleted`, whose row on `main` is left as it is.
   */
  status: FinishStatus | null;
  /** Contacts with at least one enrichment on the branch. */
  rows: number;
  enrichments: number;
  /** The run's own commit, as `commit_hash` on `main` records it. */
  commitHash: string | null;
}

/** The run row as its branch's working set holds it, with its age. */
interface BranchRunRow {
  id: string;
  plan_id: string | null;
  list_ref: string;
  status: string;
  age_seconds: unknown;
}

/**
 * Finish the runs that a dead process left on their branches.
 *
 * Every `run/<id>` branch whose run started more than `olderThanHours` ago is
 * taken as abandoned; a run that is still going finishes long before that.
 * For each one:
 *
 * - When `main` already holds the run with a `commit_hash`, the merge landed
 *   and only the branch delete was lost, so the branch is deleted and nothing
 *   else changes.
 * - Otherwise the run is finished the way a cancel finishes it: a run row
 *   still `running` becomes `partial` with `finished_at` set, the branch's
 *   working set (every row that finished before the crash) is committed, and
 *   the branch is merged into `main` through the same merge, lock and retry
 *   as {@link finishRun}. A branch that {@link finishRun} committed but could
 *   not merge is merged as it is. The branch is then deleted.
 *
 * A branch with no run row (a crash between `DOLT_BRANCH` and the insert, or
 * a start still in progress) is left alone with a warning. A branch that fails
 * is reported in `failed` and the sweep goes on with the next one.
 *
 * With `dryRun` nothing is written: the result lists what a sweep would do.
 */
export async function sweepAbandonedRuns({
  olderThanHours = DEFAULT_SWEEP_HOURS,
  dryRun = false,
}: { olderThanHours?: number; dryRun?: boolean } = {}): Promise<{
  swept: SweptBranch[];
  failed: Array<{ branch: string; error: string }>;
}> {
  if (!(olderThanHours > 0)) throw new Error(`olderThanHours must be a positive number, not ${olderThanHours}`);
  const thresholdSeconds = olderThanHours * 3600;
  const swept: SweptBranch[] = [];
  const failed: Array<{ branch: string; error: string }> = [];

  const branches = await select<{ name: string }>(
    "SELECT name FROM dolt_branches WHERE name LIKE 'run/%' ORDER BY name"
  );

  for (const { name: branch } of branches) {
    try {
      const outcome = await sweepBranch(branch, thresholdSeconds, olderThanHours, dryRun);
      if (outcome) swept.push(outcome);
    } catch (error) {
      failed.push({ branch, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { swept, failed };
}

/** Sweep one branch; null when it is not abandoned. See {@link sweepAbandonedRuns}. */
async function sweepBranch(
  branch: string,
  thresholdSeconds: number,
  olderThanHours: number,
  dryRun: boolean
): Promise<SweptBranch | null> {
  const runId = branch.slice('run/'.length);

  const connection = await connect(branch);
  let run: RunTally;
  let status: FinishStatus;
  let runCommit: string | null = null;
  const author = commitAuthor();
  const swept = `abandoned run branch older than ${olderThanHours}h`;
  let message = '';

  try {
    const [found] = await connection.query(
      `SELECT id, plan_id, list_ref, status,
         TIMESTAMPDIFF(SECOND, started_at, CURRENT_TIMESTAMP) AS age_seconds
       FROM enrichment_runs WHERE id = ?`,
      [runId]
    );
    const row = (found as BranchRunRow[])[0];
    if (!row) {
      console.warn(`[RUNS] ${branch} has no run row; left in place`);
      return null;
    }
    if (!(Number(row.age_seconds) > thresholdSeconds)) return null;

    const [onMain] = await select<{ commit_hash: string | null }>(
      'SELECT commit_hash FROM enrichment_runs WHERE id = ?',
      [runId]
    );
    if (onMain?.commit_hash) {
      if (!dryRun) await query("CALL DOLT_BRANCH('-D', ?)", [branch]);
      return { branch, runId, action: 'deleted', status: null, rows: 0, enrichments: 0, commitHash: onMain.commit_hash };
    }

    const [counted] = await connection.query(
      'SELECT COUNT(DISTINCT contact_email) AS contacts, COUNT(*) AS enrichments FROM enrichments WHERE run_id = ?',
      [runId]
    );
    const counts = (counted as Array<{ contacts: unknown; enrichments: unknown }>)[0];
    run = {
      id: runId,
      planId: row.plan_id,
      listRef: row.list_ref,
      rows: Number(counts?.contacts ?? 0),
      enrichments: Number(counts?.enrichments ?? 0),
    };
    // A run `finishRun` committed but could not merge keeps its own status.
    status = (row.status === 'running' ? 'partial' : row.status) as FinishStatus;
    if (dryRun) return { branch, runId, action: 'merged', status, rows: run.rows, enrichments: run.enrichments, commitHash: null };

    message = commitMessage(run, status, swept);
    await connection.query(
      "UPDATE enrichment_runs SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'",
      [status, runId]
    );
    runCommit = await connection
      .query("CALL DOLT_COMMIT('-Am', ?, '--author', ?)", [message, author])
      .then(([result]) => readCommitHash(result), (error: unknown) => {
        // Already committed by `finishRun`: the branch head is the run's commit.
        if (isNothingToCommit(error)) return null;
        throw error;
      });
    if (!runCommit) {
      const [head] = await connection.query("SELECT DOLT_HASHOF('HEAD') AS hash");
      runCommit = readCommitHash(head);
    }
  } finally {
    await connection.end().catch(() => undefined);
  }

  if (!runCommit) throw new Error(`Dolt returned no hash for run ${runId}'s commit`);

  await mergeWithRetry({ id: runId, branch }, runCommit, message, author);
  await query("CALL DOLT_BRANCH('-D', ?)", [branch]);

  return { branch, runId, action: 'merged', status, rows: run.rows, enrichments: run.enrichments, commitHash: runCommit };
}

/** A recorded run as `main`'s head holds it. */
export interface RunSummary {
  id: string;
  planId: string | null;
  listRef: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  /** The run's own commit; NULL until the run is merged into `main`. */
  commitHash: string | null;
}

/** One value that differs between two runs of a list. */
export interface RunChange {
  contactEmail: string;
  field: string;
  /** `added`: no value in the earlier run; `removed`: none in the later one. */
  change: 'added' | 'changed' | 'removed';
  from: string | null;
  to: string | null;
  /** The later run's confidence; null for a removed value. */
  confidence: number | null;
  /** The later run's evidence, read at its commit; empty for a removed value. */
  sources: Array<{ url: string; quote: string | null }>;
}

/** A run id that matches no run on `main`. */
export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`No run with id ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

/**
 * A run row on `main` with no `commit_hash`. A run in flight or never merged
 * has no row on `main` at all (that is a {@link RunNotFoundError}), so this
 * only happens after a hand edit of the row; kept as a defensive branch.
 */
export class RunNotCommittedError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} has no commit to read`);
    this.name = 'RunNotCommittedError';
  }
}

/** Two runs that cannot be diffed: the same run twice, or runs of different lists. */
export class RunsNotComparableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunsNotComparableError';
  }
}

const RUN_COLUMNS = 'id, plan_id, list_ref, status, started_at, finished_at, commit_hash';

interface RunRow {
  id: string;
  plan_id: string | null;
  list_ref: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  commit_hash: string | null;
}

function toRunSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    planId: row.plan_id,
    listRef: row.list_ref,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    commitHash: row.commit_hash,
  };
}

/** A run by id from `main`'s head, or null. */
export async function getRun(runId: string): Promise<RunSummary | null> {
  const [row] = await select<RunRow>(`SELECT ${RUN_COLUMNS} FROM enrichment_runs WHERE id = ?`, [runId]);
  return row ? toRunSummary(row) : null;
}

async function requireRun(runId: string): Promise<RunSummary> {
  const run = await getRun(runId);
  if (!run) throw new RunNotFoundError(runId);
  return run;
}

/**
 * The run before `runId` on the same list: the latest `completed` run with
 * an equal `list_ref` and a commit, that started earlier. Null when there is
 * none; {@link RunNotFoundError} when `runId` is unknown.
 *
 * Only `completed` runs are a default baseline: a cancelled (`partial`) run
 * that covered 3 of 100 contacts would show every field of the other 97 as
 * added. `partial` and `failed` runs can still be compared by id
 * ({@link diffRuns}, `?against=` on the route).
 *
 * `started_at` has one-second resolution, so two runs started in the same
 * second are ordered by id: one of them is the other's predecessor, never
 * both.
 */
export async function previousRunFor(runId: string): Promise<RunSummary | null> {
  const run = await requireRun(runId);
  const [row] = await select<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM enrichment_runs
     WHERE list_ref = ? AND id <> ? AND status = ? AND commit_hash IS NOT NULL
       AND (started_at < ? OR (started_at = ? AND id < ?))
     ORDER BY started_at DESC, id DESC
     LIMIT 1`,
    [run.listRef, run.id, 'completed' satisfies FinishStatus, run.startedAt, run.startedAt, run.id]
  );
  return row ? toRunSummary(row) : null;
}

/** The join key of one value: the contact (case-insensitive) and the field. */
function valueKey(email: string, field: string): string {
  return `${email.trim().toLowerCase()}\u0000${field}`;
}

/** `DECIMAL` arrives as a string from `mysql2`. */
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

interface EarlierValue {
  id: string;
  contact_email: string;
  field: string;
  value: string | null;
}

interface LaterValue extends EarlierValue {
  confidence: unknown;
  url: string | null;
  quote: string | null;
}

/**
 * The values that differ between two runs: added, changed and removed
 * values, matched on `(contact_email, field)`. Values equal in both runs
 * are left out. Each run is read `AS OF` its own commit, and the later
 * run's evidence `AS OF` the later commit, so the answer does not move when
 * `main` does.
 *
 * A list that repeats a contact records the same field more than once in a
 * run; the first row by id is compared and the rest are ignored.
 *
 * Throws {@link RunNotFoundError} for an unknown run,
 * {@link RunsNotComparableError} for the same run twice or runs of different
 * lists, and {@link RunNotCommittedError} for a run with no commit.
 */
export async function diffRuns(
  fromRunId: string,
  toRunId: string
): Promise<{ from: RunSummary; to: RunSummary; changes: RunChange[] }> {
  const from = await requireRun(fromRunId);
  const to = await requireRun(toRunId);
  if (from.id === to.id) throw new RunsNotComparableError(`Run ${to.id} cannot be diffed against itself`);
  if (from.listRef !== to.listRef) {
    throw new RunsNotComparableError(`Runs ${from.id} and ${to.id} are of different lists`);
  }
  if (!from.commitHash) throw new RunNotCommittedError(from.id);
  if (!to.commitHash) throw new RunNotCommittedError(to.id);

  // `AS OF ?` relies on mysql2's client-side interpolation (`query`, which
  // `select` uses): a server-side prepared `execute` of the same SQL crashes
  // Dolt 2.1.8's planner and drops the connection.
  const before = await select<EarlierValue>(
    'SELECT id, contact_email, field, value FROM enrichments AS OF ? WHERE run_id = ? ORDER BY id',
    [from.commitHash, from.id]
  );
  const after = await select<LaterValue>(
    `SELECT e.id, e.contact_email, e.field, e.value, e.confidence, v.url, v.quote
     FROM enrichments AS OF ? e
     LEFT JOIN evidence AS OF ? v ON v.enrichment_id = e.id
     WHERE e.run_id = ?
     ORDER BY e.id, v.id`,
    [to.commitHash, to.commitHash, to.id]
  );

  const earlier = new Map<string, EarlierValue>();
  for (const row of before) {
    const key = valueKey(row.contact_email, row.field);
    if (!earlier.has(key)) earlier.set(key, row);
  }

  // One entry per key: its first enrichment row, with every evidence row of it.
  const later = new Map<string, { row: LaterValue; sources: RunChange['sources'] }>();
  for (const row of after) {
    const key = valueKey(row.contact_email, row.field);
    let entry = later.get(key);
    if (!entry) {
      entry = { row, sources: [] };
      later.set(key, entry);
    }
    if (entry.row.id === row.id && row.url) entry.sources.push({ url: row.url, quote: row.quote });
  }

  const changes: RunChange[] = [];
  for (const [key, { row, sources }] of later) {
    const previous = earlier.get(key);
    if (previous && previous.value === row.value) continue;
    changes.push({
      contactEmail: row.contact_email,
      field: row.field,
      change: previous ? 'changed' : 'added',
      from: previous ? previous.value : null,
      to: row.value,
      confidence: numberOrNull(row.confidence),
      sources,
    });
  }
  for (const [key, row] of earlier) {
    if (later.has(key)) continue;
    changes.push({
      contactEmail: row.contact_email,
      field: row.field,
      change: 'removed',
      from: row.value,
      to: null,
      confidence: null,
      sources: [],
    });
  }

  return { from, to, changes };
}
