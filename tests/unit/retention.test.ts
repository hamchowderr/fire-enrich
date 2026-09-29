/**
 * The store's retention (lib/mastra/retention.ts): spans after
 * TRACING_RETENTION_DAYS and workflow run snapshots after
 * WORKFLOW_SNAPSHOT_RETENTION_DAYS. The prune test runs a real workflow on a
 * real libSQL file and prunes it with LibSQLStore.prune().
 */
import path from 'node:path';

import { Mastra } from '@mastra/core';
import type { RetentionConfig } from '@mastra/core/storage';
import { SpanType } from '@mastra/core/observability';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { mastra } from '@/lib/mastra';
import { snapshotRetentionDays, storageRetention } from '@/lib/mastra/retention';

const TRACING = { enabled: true, sampleRate: 1, retentionDays: 14 };
const DAY = 86_400_000;

describe('snapshotRetentionDays', () => {
  it('is 14 by default, 0 meaning forever, and falls back to 14', () => {
    expect(snapshotRetentionDays({})).toBe(14);
    expect(snapshotRetentionDays({ WORKFLOW_SNAPSHOT_RETENTION_DAYS: ' 3 ' })).toBe(3);
    expect(snapshotRetentionDays({ WORKFLOW_SNAPSHOT_RETENTION_DAYS: '0' })).toBe(0);
    expect(snapshotRetentionDays({ WORKFLOW_SNAPSHOT_RETENTION_DAYS: '-1' })).toBe(14);
    expect(snapshotRetentionDays({ WORKFLOW_SNAPSHOT_RETENTION_DAYS: 'week' })).toBe(14);
    expect(snapshotRetentionDays({ WORKFLOW_SNAPSHOT_RETENTION_DAYS: '' })).toBe(14);
  });

  it('does not follow TRACING_RETENTION_DAYS', () => {
    expect(snapshotRetentionDays({ TRACING_RETENTION_DAYS: '0' })).toBe(14);
  });
});

describe('storageRetention', () => {
  it('expires spans and workflow snapshots, each on its own setting', () => {
    expect(storageRetention(TRACING, 7)).toEqual({
      observability: { spans: { maxAge: '14d' } },
      workflows: { workflowSnapshot: { maxAge: '7d' } },
    });
    expect(storageRetention({ ...TRACING, retentionDays: 0 }, 7)).toEqual({
      workflows: { workflowSnapshot: { maxAge: '7d' } },
    });
    expect(storageRetention(TRACING, 0)).toEqual({ observability: { spans: { maxAge: '14d' } } });
    expect(storageRetention({ ...TRACING, retentionDays: 0 }, 0)).toBeUndefined();
  });

  it('expires snapshots with tracing off', () => {
    expect(storageRetention({ ...TRACING, enabled: false }, 14)).toMatchObject({
      workflows: { workflowSnapshot: { maxAge: '14d' } },
    });
  });
});

describe("the app's Mastra store", () => {
  it('is built with storageRetention, so prune() expires snapshots as well as spans', () => {
    // `retention` is a protected field of MastraCompositeStore; read it to
    // catch the store being built with the span policy alone.
    const store = mastra.getStorage() as unknown as { retention?: RetentionConfig };
    expect(process.env.WORKFLOW_SNAPSHOT_RETENTION_DAYS).toBeUndefined();
    expect(store.retention?.workflows?.workflowSnapshot?.maxAge).toBe('14d');
    expect(store.retention).toEqual(storageRetention({ ...TRACING, enabled: false }, 14));
  });
});

describe('LibSQLStore.prune() with storageRetention', () => {
  it('deletes snapshots and spans past their age, by last activity, and keeps the rest', async () => {
    const storage = new LibSQLStore({
      id: 'snapshot-retention-test',
      url: `file:${path.join(inject('tempDir'), `snapshot-retention-${process.pid}.db`)}`,
      retention: storageRetention(TRACING, 14),
    });

    // A real run persists its snapshot, input included.
    const step = createStep({
      id: 'echo',
      inputSchema: z.object({ email: z.string() }),
      outputSchema: z.object({ email: z.string() }),
      execute: async ({ inputData }) => inputData,
    });
    const workflow = createWorkflow({
      id: 'retention-probe',
      inputSchema: z.object({ email: z.string() }),
      outputSchema: z.object({ email: z.string() }),
    })
      .then(step)
      .commit();
    const mastra = new Mastra({ storage, workflows: { probe: workflow }, logger: false });
    const run = await mastra.getWorkflow('probe').createRun({ runId: 'fresh' });
    expect((await run.start({ inputData: { email: 'jane@acme.com' } })).status).toBe('success');

    const workflows = (await storage.getStore('workflows'))!;
    const fresh = await workflows.loadWorkflowSnapshot({ workflowName: 'retention-probe', runId: 'fresh' });
    expect(JSON.stringify(fresh)).toContain('jane@acme.com');

    // An old run, and one that started long ago but was active two days ago.
    const snapshot = (fresh ?? {}) as Parameters<typeof workflows.persistWorkflowSnapshot>[0]['snapshot'];
    const ago = (days: number) => new Date(Date.now() - days * DAY);
    await workflows.persistWorkflowSnapshot({
      workflowName: 'retention-probe',
      runId: 'old',
      snapshot,
      createdAt: ago(20),
      updatedAt: ago(20),
    });
    await workflows.persistWorkflowSnapshot({
      workflowName: 'retention-probe',
      runId: 'long-running',
      snapshot,
      createdAt: ago(20),
      updatedAt: ago(2),
    });

    const spans = (await storage.getStore('observability'))!;
    const at = ago(20);
    await spans.createSpan({
      span: {
        traceId: 'trace-old',
        spanId: 'old',
        name: 'old',
        spanType: SpanType.GENERIC,
        isEvent: false,
        startedAt: at,
        endedAt: at,
        parentSpanId: null,
      } as Parameters<typeof spans.createSpan>[0]['span'],
    });

    const results = await storage.prune({ maxRows: 5_000 });
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: 'observability', deleted: 1, done: true }),
        expect.objectContaining({ domain: 'workflows', table: 'mastra_workflow_snapshot', deleted: 1, done: true }),
      ])
    );

    const runIds = (await workflows.listWorkflowRuns({ workflowName: 'retention-probe' })).runs.map((r) => r.runId);
    expect(runIds.sort()).toEqual(['fresh', 'long-running']);
    expect(await spans.getTrace({ traceId: 'trace-old' })).toBeNull();
  });
});
