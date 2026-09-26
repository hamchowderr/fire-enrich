/**
 * Tracing configuration (lib/mastra/tracing.ts): the switch, the sample rate,
 * retention, and the observability it builds. The retention test prunes a real
 * libSQL file.
 */
import path from 'node:path';

import { SamplingStrategyType, SpanType } from '@mastra/core/observability';
import { LibSQLStore } from '@mastra/libsql';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { inject } from 'vitest';
import { describe, expect, it } from 'vitest';

import { createObservability, tracingConfig, tracingRetention } from '@/lib/mastra/tracing';

describe('tracingConfig', () => {
  it('is on, keeping every trace for 14 days, by default', () => {
    expect(tracingConfig({})).toEqual({ enabled: true, sampleRate: 1, retentionDays: 14 });
  });

  it.each(['0', 'false', 'off', 'no', 'disabled', ' FALSE ', 'Off', 'NO', ' Disabled '])('turns off with %j', (value) => {
    expect(tracingConfig({ TRACING: value }).enabled).toBe(false);
  });

  it.each(['1', 'true', 'on', 'yes', '', 'anything'])('stays on with %j', (value) => {
    expect(tracingConfig({ TRACING: value }).enabled).toBe(true);
  });

  it('reads the sample rate and falls back to 1 for one that is not a probability', () => {
    expect(tracingConfig({ TRACING_SAMPLE_RATE: '0.25' }).sampleRate).toBe(0.25);
    expect(tracingConfig({ TRACING_SAMPLE_RATE: 'most' }).sampleRate).toBe(1);
    expect(tracingConfig({ TRACING_SAMPLE_RATE: '2' }).sampleRate).toBe(1);
  });

  it('reads the retention days, 0 meaning forever, and falls back to 14', () => {
    expect(tracingConfig({ TRACING_RETENTION_DAYS: '3' }).retentionDays).toBe(3);
    expect(tracingConfig({ TRACING_RETENTION_DAYS: '0' }).retentionDays).toBe(0);
    expect(tracingConfig({ TRACING_RETENTION_DAYS: '-1' }).retentionDays).toBe(14);
    expect(tracingConfig({ TRACING_RETENTION_DAYS: 'week' }).retentionDays).toBe(14);
  });
});

describe('tracingRetention', () => {
  it('expires spans after the configured days, and sets nothing at 0', () => {
    expect(tracingRetention({ enabled: true, sampleRate: 1, retentionDays: 14 })).toEqual({
      observability: { spans: { maxAge: '14d' } },
    });
    expect(tracingRetention({ enabled: false, sampleRate: 1, retentionDays: 7 })).toEqual({
      observability: { spans: { maxAge: '7d' } },
    });
    expect(tracingRetention({ enabled: true, sampleRate: 1, retentionDays: 0 })).toBeUndefined();
  });

  it('lets LibSQLStore.prune() delete spans older than the retention, and only those', async () => {
    const store = new LibSQLStore({
      id: 'retention-test',
      url: `file:${path.join(inject('tempDir'), `retention-${process.pid}.db`)}`,
      retention: tracingRetention({ enabled: true, sampleRate: 1, retentionDays: 14 }),
    });
    await store.init();
    const spans = (await store.getStore('observability'))!;

    const span = (spanId: string, daysAgo: number) => {
      const at = new Date(Date.now() - daysAgo * 86_400_000);
      return {
        traceId: `trace-${spanId}`,
        spanId,
        name: spanId,
        spanType: SpanType.GENERIC,
        isEvent: false,
        startedAt: at,
        endedAt: at,
        parentSpanId: null,
      };
    };
    for (const [id, days] of [
      ['old', 20],
      ['new', 2],
    ] as const) {
      await spans.createSpan({ span: span(id, days) as Parameters<typeof spans.createSpan>[0]['span'] });
    }

    const results = await store.prune({ maxRows: 5_000 });
    expect(results).toEqual([expect.objectContaining({ domain: 'observability', deleted: 1, done: true })]);
    expect(await spans.getTrace({ traceId: 'trace-old' })).toBeNull();
    expect(await spans.getTrace({ traceId: 'trace-new' })).not.toBeNull();
  });
});

describe('createObservability', () => {
  it('builds nothing when tracing is off', () => {
    expect(createObservability({ enabled: false, sampleRate: 1, retentionDays: 14 })).toBeUndefined();
  });

  it('exports to Mastra storage as fire-enrich, sampled at the configured rate', async () => {
    const observability = createObservability({ enabled: true, sampleRate: 0.3, retentionDays: 14 });
    expect(observability).toBeInstanceOf(Observability);

    const config = observability!.getDefaultInstance()!.getConfig();
    expect(config.serviceName).toBe('fire-enrich');
    expect(config.sampling).toEqual({ type: SamplingStrategyType.RATIO, probability: 0.3 });
    expect(config.exporters).toHaveLength(1);
    expect(config.exporters[0]).toBeInstanceOf(MastraStorageExporter);
    expect(config.excludeSpanTypes).toEqual([SpanType.MODEL_CHUNK]);
    await observability!.shutdown();
  });

  it('samples every trace at rate 1 and none at rate 0', async () => {
    for (const [rate, type] of [
      [1, SamplingStrategyType.ALWAYS],
      [0, SamplingStrategyType.NEVER],
    ] as const) {
      const observability = createObservability({ enabled: true, sampleRate: rate, retentionDays: 14 })!;
      expect(observability.getDefaultInstance()!.getConfig().sampling).toEqual({ type });
      await observability.shutdown();
    }
  });
});
