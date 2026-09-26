/**
 * The evidence-support check (lib/mastra/evidence-support.ts) on a
 * hand-written evaluation model. AIMock cannot serve evaluation models, so the
 * fake below implements `Experimental_EvaluationModelV4` directly: its
 * `doEvaluate` answers the one boolean question with a probability chosen per
 * quote, or throws, or never settles.
 */
import { SpanType, type AnyExportedSpan, type TracingContext, type TracingEvent } from '@mastra/core/observability';
import { initContextStorage } from '@mastra/core/observability/context-storage';
import { BaseExporter, Observability } from '@mastra/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkEvidenceSupport,
  createEvidenceSupportClassifier,
  evidenceCheckConfig,
  MAX_TRACED_CHARS,
} from '@/lib/mastra/evidence-support';
import type { FindingType } from '@/lib/mastra/schemas';

type EvaluationModel = Parameters<typeof createEvidenceSupportClassifier>[0];
type CallOptions = Parameters<EvaluationModel['doEvaluate']>[0];

/** What the fake does for a quote: answer with a probability, throw, or hang. */
type Behaviour = number | 'throw' | 'hang';

function fakeModel(behaviourFor: (quote: string) => Behaviour) {
  const calls: CallOptions[] = [];
  const model: EvaluationModel = {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'fake-jev',
    supportedQuestionTypes: ['boolean'],
    async doEvaluate(options) {
      calls.push(options);
      const behaviour = behaviourFor((options.state as { quote: string }).quote);
      if (behaviour === 'throw') throw new Error('gateway unavailable');
      if (behaviour === 'hang') {
        // Never settles on its own; ignores the abort signal on purpose, so the
        // check's own timeout is what ends the wait.
        return new Promise(() => {});
      }
      return { answers: { supported: { type: 'boolean', probability: behaviour } }, warnings: [] };
    },
  };
  return { model, calls };
}

const finding = (field: string, value: FindingType['value'], quote: string): FindingType => ({
  field,
  value,
  confidence: 0.9,
  evidence: [{ url: 'https://firecrawl.dev/', quote, confidence: 0.9 }],
  sourcesAgree: true,
});

const SUPPORTED = finding('product_summary', 'The web data API for AI', 'Firecrawl is the web data API for AI.');
const UNSUPPORTED = finding('employee_count', 250, 'Trusted by 150,000+ developers.');
const NULL_FINDING: FindingType = {
  field: 'funding_stage',
  value: null,
  confidence: 0,
  evidence: [],
  sourcesAgree: true,
};

const fieldDescriptions = new Map([
  ['product_summary', 'What the company sells'],
  ['employee_count', 'Number of employees'],
]);

function run(
  model: EvaluationModel,
  findings: readonly FindingType[],
  extra: { abortSignal?: AbortSignal; timeoutMs?: number; threshold?: number; tracingContext?: TracingContext } = {}
) {
  return checkEvidenceSupport(findings, {
    classifier: createEvidenceSupportClassifier(model),
    threshold: extra.threshold ?? 0.5,
    fieldDescriptions,
    groupId: 'product',
    abortSignal: extra.abortSignal,
    timeoutMs: extra.timeoutMs,
    tracingContext: extra.tracingContext,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('evidenceCheckConfig', () => {
  it('is off with a 0.5 threshold by default', () => {
    expect(evidenceCheckConfig({})).toEqual({ enabled: false, threshold: 0.5 });
  });

  it('turns on with 1 or true and reads the threshold', () => {
    expect(evidenceCheckConfig({ EVIDENCE_CHECK: '1', EVIDENCE_CHECK_THRESHOLD: '0.7' })).toEqual({
      enabled: true,
      threshold: 0.7,
    });
    expect(evidenceCheckConfig({ EVIDENCE_CHECK: 'true' }).enabled).toBe(true);
    expect(evidenceCheckConfig({ EVIDENCE_CHECK: '0' }).enabled).toBe(false);
  });

  it('falls back to 0.5 for a threshold that is not a probability', () => {
    expect(evidenceCheckConfig({ EVIDENCE_CHECK_THRESHOLD: 'high' }).threshold).toBe(0.5);
    expect(evidenceCheckConfig({ EVIDENCE_CHECK_THRESHOLD: '1.5' }).threshold).toBe(0.5);
  });
});

describe('checkEvidenceSupport', () => {
  it('keeps a finding at or above the threshold and drops one below, as checkFindings would', async () => {
    const { model, calls } = fakeModel((quote) => (quote.includes('web data API') ? 0.92 : 0.08));

    const result = await run(model, [SUPPORTED, UNSUPPORTED]);

    expect(result.findings[0]).toEqual(SUPPORTED);
    expect(result.findings[1]).toEqual({ ...UNSUPPORTED, value: null, confidence: 0, evidence: [] });
    expect(result.notes).toEqual([expect.stringMatching(/"employee_count": .*did not support the value.*p=0\.08/)]);
    expect(calls).toHaveLength(2);
    expect(calls[1].state).toEqual({
      field: 'employee_count',
      fieldDescription: 'Number of employees',
      value: 250,
      quote: 'Trusted by 150,000+ developers.',
    });
    expect(Object.keys(calls[1].questions)).toEqual(['supported']);
  });

  it('keeps a finding exactly at the threshold', async () => {
    const { model } = fakeModel(() => 0.5);
    const result = await run(model, [SUPPORTED]);
    expect(result.findings).toEqual([SUPPORTED]);
  });

  it('makes no call for a finding with no value', async () => {
    const { model, calls } = fakeModel(() => 0.9);
    const result = await run(model, [NULL_FINDING]);
    expect(result.findings).toEqual([NULL_FINDING]);
    expect(calls).toHaveLength(0);
  });

  it('fails open when the classifier throws, with one warning line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { model } = fakeModel(() => 'throw');

    const result = await run(model, [SUPPORTED, UNSUPPORTED]);

    expect(result.findings).toEqual([SUPPORTED, UNSUPPORTED]);
    expect(result.notes).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/\[EVIDENCE\] group "product": .*2 finding\(s\), kept unchecked/);
  });

  it('fails open when a call exceeds the timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { model } = fakeModel((quote) => (quote.includes('web data API') ? 'hang' : 0.08));

    const result = await run(model, [SUPPORTED, UNSUPPORTED], { timeoutMs: 20 });

    expect(result.findings[0]).toEqual(SUPPORTED);
    expect(result.findings[1].value).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/product_summary \(TimeoutError/);
  });

  it('makes no call once the run is cancelled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { model, calls } = fakeModel(() => 0.01);
    const controller = new AbortController();
    controller.abort();

    const result = await run(model, [SUPPORTED, UNSUPPORTED], { abortSignal: controller.signal });

    expect(calls).toHaveLength(0);
    expect(result.findings).toEqual([SUPPORTED, UNSUPPORTED]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stops waiting when the run is cancelled mid-call, without a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { model, calls } = fakeModel(() => 'hang');
    const controller = new AbortController();

    const pending = run(model, [SUPPORTED], { abortSignal: controller.signal, timeoutMs: 60_000 });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].abortSignal?.aborted).toBe(false);
    controller.abort();

    const result = await pending;
    expect(calls[0].abortSignal?.aborted).toBe(true);
    expect(result.findings).toEqual([SUPPORTED]);
    expect(warn).not.toHaveBeenCalled();
  });
});

/** Keeps every span that ends, in memory. */
class CaptureExporter extends BaseExporter {
  name = 'capture';
  readonly ended: AnyExportedSpan[] = [];

  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (event.type === 'span_ended') this.ended.push(event.exportedSpan);
  }
}

/**
 * A real observability instance exporting to memory, and a root span standing
 * in for the research step. `finish` ends the root and returns what was
 * exported.
 */
function traced() {
  // The Mastra constructor does this in the app: it lets the classifier find
  // the span it runs inside.
  initContextStorage();
  const exporter = new CaptureExporter();
  const observability = new Observability({
    configs: { test: { serviceName: 'fire-enrich-test', exporters: [exporter] } },
  });
  const root = observability.getInstance('test')!.startSpan({ type: SpanType.GENERIC, name: 'research-group' });

  return {
    tracingContext: { currentSpan: root } as TracingContext,
    async finish() {
      root.end();
      await observability.flush();
      await observability.shutdown();
      const checks = exporter.ended.filter((span) => span.name.startsWith('evidence-support: '));
      const byField = (field: string) => checks.find((span) => span.name === `evidence-support: ${field}`);
      return { root, spans: exporter.ended, checks, byField };
    },
  };
}

describe('checkEvidenceSupport tracing', () => {
  it('records one span per checked finding with field, probability, threshold and decision', async () => {
    const trace = traced();
    const { model } = fakeModel((quote) => (quote.includes('web data API') ? 0.92 : 0.08));

    await run(model, [SUPPORTED, UNSUPPORTED, NULL_FINDING], { tracingContext: trace.tracingContext, threshold: 0.6 });
    const { root, spans, checks, byField } = await trace.finish();

    // No span for the finding with no value: it is not checked.
    expect(checks).toHaveLength(2);

    const kept = byField('product_summary')!;
    expect(kept.type).toBe(SpanType.GENERIC);
    expect(kept.parentSpanId).toBe(root.id);
    expect(kept.metadata).toMatchObject({ field: 'product_summary', probability: 0.92, threshold: 0.6, decision: 'kept' });
    expect(kept.output).toEqual({ decision: 'kept', probability: 0.92 });
    expect(kept.input).toEqual({
      field: 'product_summary',
      value: 'The web data API for AI',
      quote: 'Firecrawl is the web data API for AI.',
    });

    const dropped = byField('employee_count')!;
    expect(dropped.metadata).toMatchObject({ field: 'employee_count', probability: 0.08, threshold: 0.6, decision: 'dropped' });

    // The classifier's own span runs inside the check's span.
    const evaluations = spans.filter((span) => span.type === SpanType.CLASSIFIER_EVALUATION);
    expect(evaluations).toHaveLength(2);
    expect(evaluations.map((span) => span.parentSpanId).sort()).toEqual([kept.id, dropped.id].sort());
  });

  it('records a failed check as failed, with the error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const trace = traced();
    const { model } = fakeModel(() => 'throw');

    await run(model, [SUPPORTED], { tracingContext: trace.tracingContext });
    const { byField } = await trace.finish();

    expect(byField('product_summary')!.metadata).toMatchObject({
      probability: null,
      threshold: 0.5,
      decision: 'failed',
      error: expect.stringContaining('gateway unavailable'),
    });
  });

  it('records a check stopped by a cancelled run as cancelled', async () => {
    const trace = traced();
    const { model, calls } = fakeModel(() => 'hang');
    const controller = new AbortController();

    const pending = run(model, [SUPPORTED], {
      tracingContext: trace.tracingContext,
      abortSignal: controller.signal,
      timeoutMs: 60_000,
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    await pending;
    const { byField } = await trace.finish();

    expect(byField('product_summary')!.metadata).toMatchObject({ decision: 'cancelled', probability: null });
    expect(byField('product_summary')!.metadata).not.toHaveProperty('error');
  });

  it('cuts a long quote and value on the span, but sends the model the full quote', async () => {
    const trace = traced();
    const { model, calls } = fakeModel(() => 0.9);
    const long = 'x'.repeat(MAX_TRACED_CHARS + 100);

    await run(model, [finding('product_summary', long, long)], { tracingContext: trace.tracingContext });
    const { byField } = await trace.finish();

    const input = byField('product_summary')!.input as { value: string; quote: string };
    expect(input.quote).toBe(`${'x'.repeat(MAX_TRACED_CHARS)}… (${long.length} chars)`);
    expect(input.value).toBe(input.quote);
    expect((calls[0].state as { quote: string }).quote).toBe(long);
  });
});
