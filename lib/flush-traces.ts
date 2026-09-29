import { after } from 'next/server';

import { mastra } from '@/lib/mastra';

/**
 * Least time between two prunes by one server instance. A serverless instance
 * lives minutes to hours, so in practice this is about one prune per instance.
 */
const PRUNE_INTERVAL_MS = 60 * 60_000;

/**
 * Most rows one prune deletes from each table. A row writes a few dozen spans
 * and one workflow snapshot, so this clears well over a hundred expired rows'
 * spans per prune; what is left waits for the next.
 */
const PRUNE_MAX_ROWS = 5_000;

const pruneState = globalThis as typeof globalThis & { __fireEnrichLastPrune?: number };

/**
 * Delete trace spans older than `TRACING_RETENTION_DAYS` and workflow run
 * snapshots older than `WORKFLOW_SNAPSHOT_RETENTION_DAYS` (the store's
 * `retention`, `lib/mastra/retention.ts`), at most once per
 * {@link PRUNE_INTERVAL_MS} per server instance and at most
 * {@link PRUNE_MAX_ROWS} rows per table at a time. A no-op when both are 0 (no
 * policy is configured, so `prune()` returns at once).
 *
 * Run from `after()` rather than a Vercel cron route so that every deployment
 * (Vercel with no extra settings, `next start`, `next dev`) prunes without a
 * scheduler or a `CRON_SECRET` to set. Overlapping prunes from two instances
 * are harmless: each deletes only rows past the cutoff, in bounded batches.
 *
 * @public Tests call it directly.
 */
export async function pruneTraces(now = Date.now()): Promise<void> {
  const last = pruneState.__fireEnrichLastPrune;
  if (last !== undefined && now - last < PRUNE_INTERVAL_MS) return;
  pruneState.__fireEnrichLastPrune = now;

  try {
    const results = (await mastra.getStorage()?.prune({ maxRows: PRUNE_MAX_ROWS })) ?? [];
    const deleted = results.filter((result) => result.deleted > 0);
    if (deleted.length > 0) {
      console.log(`[TRACING] pruned ${deleted.map((result) => `${result.deleted} from ${result.table}`).join(', ')}`);
    }
  } catch (error) {
    console.warn('[TRACING] prune failed:', error instanceof Error ? error.message : error);
  }
}

/**
 * Write the spans the trace exporter still holds, then prune expired spans
 * ({@link pruneTraces}), inside Next.js `after()`, once `done` settles (or once
 * the response is sent, without it).
 *
 * The exporter (`lib/mastra/tracing.ts`) buffers spans and writes them in
 * batches up to 5 s apart. On Vercel a function can be frozen as soon as its
 * work ends, which would leave the last batch in memory. `after()` runs once
 * the response is finished, so neither step adds latency to it. A streaming
 * route passes the promise that settles when its stream ends; a plain route
 * passes nothing. Never throws: a failure is logged and dropped. With tracing
 * off the flush is a no-op; the prune still expires spans recorded earlier.
 */
export function flushTracesAfter(done?: Promise<unknown>): void {
  after(async () => {
    await done?.catch(() => {});
    try {
      await mastra.observability.flush();
    } catch (error) {
      console.warn('[TRACING] flush failed:', error instanceof Error ? error.message : error);
    }
    await pruneTraces();
  });
}
