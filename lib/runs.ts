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
 * Merges into `main` run one at a time in this process ({@link withMainLock})
 * and inside a SQL transaction, so a profile write on `main` in between cannot
 * be swept into a run's merge, nor the merge into a profile commit.
 *
 * ## Limits
 *
 * - The merge lock is per process. Several app instances against one Dolt
 *   server can still merge at the same moment; Dolt then rejects the later
 *   transaction commit, and the merge is retried ({@link MERGE_ATTEMPTS})
 *   rather than lost. Runs never conflict at the row level (every row they
 *   write has a fresh nanoid key), so a retry always applies cleanly.
 * - A run in flight is only visible on its branch
 *   (`SELECT * FROM enrichment_runs AS OF 'run/<id>'`, or `dolt_branches`),
 *   not on `main`, until it finishes.
 * - A process that dies mid-run leaves `run/<id>` behind with its rows
 *   uncommitted in the branch's working set. Nothing sweeps those yet.
 * - One extra connection per run in flight, outside the pool.
 * - Dolt refuses a merge into `main` while `main`'s working set holds
 *   uncommitted changes to a table the merge touches ("local changes would be
 *   stomped by merge"). Writes to the run tables only ever arrive by merge, and
 *   profile writes commit at once, so this only happens after a manual,
 *   uncommitted edit of those tables on `main`; the run then stays on its
 *   branch, committed but unmerged.
 */
import { createHash } from 'node:crypto';

import type mysql from 'mysql2/promise';
import { nanoid } from 'nanoid';

import { connect, query, readCommitHash } from '@/lib/dolt';
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

/** Commit message for a run: a summary line, then trailers `dolt_log` can be filtered on. */
function commitMessage(run: ActiveRun, status: FinishStatus): string {
  return [
    `Enrichment run ${run.id}: ${status}, ${run.rows} row${run.rows === 1 ? '' : 's'}, ${run.enrichments} enrichment${run.enrichments === 1 ? '' : 's'}`,
    '',
    `Run-Id: ${run.id}`,
    `Plan-Id: ${run.planId ?? 'none'}`,
    `List-Ref: ${run.listRef.replace(/\s+/g, ' ')}`,
    `Status: ${status}`,
  ].join('\n');
}

/** A transient failure of a concurrent write to `main`, worth retrying. */
function isRetryableMergeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /concurrent|serialization|deadlock|try restarting transaction|working set/i.test(message);
}

/** The `conflicts` count of a `DOLT_MERGE` result, whichever shape the driver returns. */
function mergeConflicts(result: unknown): number {
  const first = Array.isArray(result) ? result[0] : result;
  const row = Array.isArray(first) ? first[0] : first;
  return Number((row as { conflicts?: unknown } | undefined)?.conflicts ?? 0);
}

/**
 * Merge the run's branch into `main` and record its commit hash there, as one
 * merge commit. Returns the merge commit's hash.
 */
async function mergeIntoMain(run: ActiveRun, runCommit: string, message: string, author: string): Promise<string | null> {
  const connection = await connect();
  try {
    await connection.query('START TRANSACTION');
    try {
      const [merge] = await connection.query("CALL DOLT_MERGE('--no-ff', '--no-commit', ?)", [run.branch]);
      if (mergeConflicts(merge) > 0) throw new Error(`Merging ${run.branch} into main conflicted`);

      await connection.query('UPDATE enrichment_runs SET commit_hash = ? WHERE id = ?', [runCommit, run.id]);
      const [committed] = await connection.query("CALL DOLT_COMMIT('-Am', ?, '--author', ?)", [
        `Merge ${message}`,
        author,
      ]);
      await connection.query('COMMIT');
      return readCommitHash(committed);
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await connection.end().catch(() => undefined);
  }
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

  const hash = runCommit;
  await withMainLock(async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await mergeIntoMain(run, hash, message, author);
        return;
      } catch (error) {
        if (attempt >= MERGE_ATTEMPTS || !isRetryableMergeError(error)) throw error;
      }
    }
  });

  // Merged, so the branch only duplicates what `main` now holds. A failure
  // here leaves a stale pointer, not lost data.
  await query("CALL DOLT_BRANCH('-d', ?)", [run.branch]).catch((error) => {
    console.warn(`[RUNS] Could not delete ${run.branch}: ${error instanceof Error ? error.message : error}`);
  });

  return hash;
}
