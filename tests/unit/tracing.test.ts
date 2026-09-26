/**
 * Tracing configuration (lib/mastra/tracing.ts): the switch, the sample rate,
 * and the observability it builds.
 */
import { SamplingStrategyType, SpanType } from '@mastra/core/observability';
import { MastraStorageExporter, Observability } from '@mastra/observability';
import { describe, expect, it } from 'vitest';

import { createObservability, tracingConfig } from '@/lib/mastra/tracing';

describe('tracingConfig', () => {
  it('is on, keeping every trace, by default', () => {
    expect(tracingConfig({})).toEqual({ enabled: true, sampleRate: 1 });
  });

  it('turns off with 0, false or off', () => {
    for (const value of ['0', 'false', 'off', ' OFF ']) {
      expect(tracingConfig({ TRACING: value }).enabled).toBe(false);
    }
    expect(tracingConfig({ TRACING: '1' }).enabled).toBe(true);
  });

  it('reads the sample rate and falls back to 1 for one that is not a probability', () => {
    expect(tracingConfig({ TRACING_SAMPLE_RATE: '0.25' }).sampleRate).toBe(0.25);
    expect(tracingConfig({ TRACING_SAMPLE_RATE: 'most' }).sampleRate).toBe(1);
    expect(tracingConfig({ TRACING_SAMPLE_RATE: '2' }).sampleRate).toBe(1);
  });
});

describe('createObservability', () => {
  it('builds nothing when tracing is off', () => {
    expect(createObservability({ enabled: false, sampleRate: 1 })).toBeUndefined();
  });

  it('exports to Mastra storage as fire-enrich, sampled at the configured rate', async () => {
    const observability = createObservability({ enabled: true, sampleRate: 0.3 });
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
      const observability = createObservability({ enabled: true, sampleRate: rate })!;
      expect(observability.getDefaultInstance()!.getConfig().sampling).toEqual({ type });
      await observability.shutdown();
    }
  });
});
