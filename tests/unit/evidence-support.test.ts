/**
 * The evidence-support check (lib/mastra/evidence-support.ts) on a
 * hand-written evaluation model. AIMock cannot serve evaluation models, so the
 * fake below implements `Experimental_EvaluationModelV4` directly: its
 * `doEvaluate` answers the one boolean question with a probability chosen per
 * quote, or throws, or never settles.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkEvidenceSupport,
  createEvidenceSupportClassifier,
  evidenceCheckConfig,
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
  extra: { abortSignal?: AbortSignal; timeoutMs?: number; threshold?: number } = {}
) {
  return checkEvidenceSupport(findings, {
    classifier: createEvidenceSupportClassifier(model),
    threshold: extra.threshold ?? 0.5,
    fieldDescriptions,
    groupId: 'product',
    abortSignal: extra.abortSignal,
    timeoutMs: extra.timeoutMs,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('evidenceCheckConfig', () => {
  it('is on with a 0.5 threshold by default', () => {
    expect(evidenceCheckConfig({})).toEqual({ enabled: true, threshold: 0.5 });
    expect(evidenceCheckConfig({ EVIDENCE_CHECK: '' }).enabled).toBe(true);
  });

  it('turns off with 0 or false', () => {
    expect(evidenceCheckConfig({ EVIDENCE_CHECK: '0' }).enabled).toBe(false);
    expect(evidenceCheckConfig({ EVIDENCE_CHECK: 'false' }).enabled).toBe(false);
    expect(evidenceCheckConfig({ EVIDENCE_CHECK: ' FALSE ' }).enabled).toBe(false);
  });

  it('stays on with 1 or true and reads the threshold', () => {
    expect(evidenceCheckConfig({ EVIDENCE_CHECK: '1', EVIDENCE_CHECK_THRESHOLD: '0.7' })).toEqual({
      enabled: true,
      threshold: 0.7,
    });
    expect(evidenceCheckConfig({ EVIDENCE_CHECK: 'true' }).enabled).toBe(true);
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
