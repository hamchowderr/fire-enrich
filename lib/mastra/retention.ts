/**
 * What the Mastra store deletes when `storage.prune()` runs (from
 * `lib/flush-traces.ts`, after a route's response, at most once an hour per
 * server instance).
 *
 * - Trace spans (`mastra_ai_spans`) after `TRACING_RETENTION_DAYS`
 *   (`tracingRetention`, `tracing.ts`).
 * - Workflow run snapshots (`mastra_workflow_snapshot`) after
 *   `WORKFLOW_SNAPSHOT_RETENTION_DAYS`.
 *
 * Mastra writes one snapshot per `enrichRow` run, whether or not tracing is on.
 * It holds the run's input (the row's email address, the plan and the fields)
 * and every step's result, unmasked. Nothing in this app reads a snapshot once
 * its run has ended: `enrichRow` never suspends, so no run is resumed, and the
 * Dolt run history is written from the workflow's result, not from the
 * snapshot. Studio lists runs from this table, so a pruned run leaves Studio's
 * run list; its trace stays until the span retention removes it.
 *
 * LibSQLStore anchors the snapshot policy on `updatedAt`, the run's last
 * activity, so a run that is still going is not deleted by its start time.
 */
import type { RetentionConfig } from '@mastra/core/storage';

import { tracingRetention, type TracingConfig } from './tracing';

const DEFAULT_SNAPSHOT_RETENTION_DAYS = 14;

/**
 * `WORKFLOW_SNAPSHOT_RETENTION_DAYS`: days a workflow run snapshot is kept after
 * the run's last activity. Default 14; `0` keeps snapshots forever; anything
 * unparsable or negative uses 14.
 *
 * A variable of its own, not `TRACING_RETENTION_DAYS`: snapshots are written
 * with tracing on or off, and keeping traces forever (`0`) should not also keep
 * every uploaded row's email address forever.
 *
 * @public Tests read it with a given environment.
 */
export function snapshotRetentionDays(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const text = env.WORKFLOW_SNAPSHOT_RETENTION_DAYS?.trim();
  const days = text ? Number(text) : Number.NaN;
  return Number.isFinite(days) && days >= 0 ? days : DEFAULT_SNAPSHOT_RETENTION_DAYS;
}

/**
 * The LibSQLStore's `retention`: the span policy and the workflow snapshot
 * policy, each left out at 0 days. Undefined when neither is set, so `prune()`
 * returns at once.
 */
export function storageRetention(
  tracing: TracingConfig,
  snapshotDays: number = snapshotRetentionDays()
): RetentionConfig | undefined {
  const retention: RetentionConfig = { ...tracingRetention(tracing) };
  if (snapshotDays > 0) retention.workflows = { workflowSnapshot: { maxAge: `${snapshotDays}d` } };
  return Object.keys(retention).length > 0 ? retention : undefined;
}
