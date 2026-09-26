/**
 * The evidence check against the real evaluation model, on a labeled set.
 *
 * Skipped unless `EVIDENCE_LIVE=1`, so the normal suite and CI never call the
 * gateway. It makes one Jev call per finding in `labeled-findings.json`
 * through the app's own `checkEvidenceSupport` and
 * `createEvidenceSupportClassifier`, so the state and question are exactly
 * what a run sends. It prints each finding's score and, per field type
 * (quoted or classification), how many correct values the threshold drops and
 * how many wrong values it keeps, at 0.5 and across a sweep of thresholds.
 *
 * Run it with `EVIDENCE_LIVE=1` set and the gateway key injected, for example:
 *
 *   EVIDENCE_LIVE=1 infisical run --path=/fire-enrich --silent -- \
 *     npx vitest run tests/evidence/evidence-support.live.test.ts --disableConsoleIntercept
 *
 * `--disableConsoleIntercept` prints the report; Vitest does not show the
 * console output of a passing test otherwise.
 *
 * `tests/setup.ts` hands the real `AI_GATEWAY_API_KEY` to this file as
 * `EVIDENCE_LIVE_GATEWAY_KEY` and stubs the global key as usual.
 *
 * Optional variables:
 * - `EVIDENCE_LIVE_MAX_CALLS`: hard cap on gateway calls, retries included.
 *   Default: the size of the set. A call past the cap fails instead of being made.
 * - `EVIDENCE_LIVE_OUT`: path of a JSON file to write the scores to.
 * - `EVIDENCE_CHECK_THRESHOLD`: the threshold the keep/drop column uses.
 *
 * Cost: well under a thousand input tokens per call; typesafe-ai/jev lists
 * input at $0.042 per million tokens, so a full pass of the set costs well
 * under a cent.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createGateway } from '@ai-sdk/gateway';
import { describe, expect, it } from 'vitest';

import {
  checkEvidenceSupport,
  createEvidenceSupportClassifier,
  evidenceCheckConfig,
  EVIDENCE_MODEL_ID,
} from '@/lib/mastra/evidence-support';
import type { FindingType } from '@/lib/mastra/schemas';

type EvaluationModel = Parameters<typeof createEvidenceSupportClassifier>[0];

interface LabeledFinding {
  id: string;
  source: 'recorded' | 'authored';
  fieldType: 'quoted' | 'classification';
  field: string;
  value: FindingType['value'];
  quote: string;
  label: 'supported' | 'unsupported';
  note?: string;
}

interface LabeledSet {
  labelingRule: string[];
  fields: Record<string, string>;
  findings: LabeledFinding[];
}

interface Scored extends LabeledFinding {
  probability: number;
  kept: boolean;
}

const SET_PATH = fileURLToPath(new URL('./labeled-findings.json', import.meta.url));
const BATCH = 8;
const TIMEOUT_MS = 15_000;
const SWEEP = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

const live = process.env.EVIDENCE_LIVE === '1';

function keyOf(state: { field: unknown; value: unknown; quote: unknown }): string {
  return JSON.stringify([state.field, state.value, state.quote]);
}

function toFinding(item: LabeledFinding): FindingType {
  return {
    field: item.field,
    value: item.value,
    confidence: 0.9,
    evidence: [{ url: 'https://example.com/', quote: item.quote, confidence: 0.9 }],
    sourcesAgree: true,
  };
}

/** Wrong decisions at a threshold: correct values dropped, wrong values kept. */
function errorsAt(scored: readonly Scored[], threshold: number) {
  const falseDrops = scored.filter((s) => s.label === 'supported' && s.probability < threshold);
  const falseKeeps = scored.filter((s) => s.label === 'unsupported' && s.probability >= threshold);
  return { falseDrops, falseKeeps };
}

function spread(values: number[]): string {
  if (values.length === 0) return 'n/a';
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  return `n=${sorted.length} min ${sorted[0].toFixed(2)} median ${median.toFixed(2)} max ${sorted[sorted.length - 1].toFixed(2)}`;
}

describe.skipIf(!live)('evidence check on the labeled set (live gateway)', () => {
  it('scores every finding and reports the errors per field type', { timeout: 300_000 }, async () => {
    const set = JSON.parse(readFileSync(SET_PATH, 'utf8')) as LabeledSet;
    const apiKey = process.env.EVIDENCE_LIVE_GATEWAY_KEY;
    expect(apiKey, 'EVIDENCE_LIVE=1 needs AI_GATEWAY_API_KEY in the environment').toBeTruthy();

    const maxCalls = Number(process.env.EVIDENCE_LIVE_MAX_CALLS ?? set.findings.length);
    const { threshold } = evidenceCheckConfig();

    // The real gateway model, wrapped to count calls, enforce the cap and
    // record each probability (checkEvidenceSupport reports only drops).
    const inner = createGateway({ apiKey }).evaluationModel(EVIDENCE_MODEL_ID);
    let calls = 0;
    const probabilities = new Map<string, number>();
    const model: EvaluationModel = {
      specificationVersion: inner.specificationVersion,
      provider: inner.provider,
      modelId: inner.modelId,
      supportedQuestionTypes: inner.supportedQuestionTypes,
      async doEvaluate(options) {
        calls += 1;
        if (calls > maxCalls) throw new Error(`call budget of ${maxCalls} reached`);
        const result = await inner.doEvaluate(options);
        const answer = result.answers.supported;
        if (answer?.type === 'boolean') {
          probabilities.set(keyOf(options.state as Parameters<typeof keyOf>[0]), answer.probability);
        }
        return result;
      },
    };
    const classifier = createEvidenceSupportClassifier(model);
    const fieldDescriptions = new Map(Object.entries(set.fields));

    const scored: Scored[] = [];
    for (let start = 0; start < set.findings.length; start += BATCH) {
      const batch = set.findings.slice(start, start + BATCH);
      const result = await checkEvidenceSupport(batch.map(toFinding), {
        classifier,
        threshold,
        fieldDescriptions,
        groupId: 'labeled-set',
        timeoutMs: TIMEOUT_MS,
      });
      batch.forEach((item, index) => {
        const probability = probabilities.get(keyOf({ field: item.field, value: item.value, quote: item.quote }));
        if (probability === undefined) return;
        scored.push({ ...item, probability, kept: result.findings[index].value !== null });
      });
    }

    const lines: string[] = [];
    lines.push(`Gateway calls: ${calls} (cap ${maxCalls}); scored ${scored.length} of ${set.findings.length}`);
    lines.push('');
    lines.push('id   type            label        p     kept  field = value');
    for (const s of scored) {
      lines.push(
        `${s.id.padEnd(4)} ${s.fieldType.padEnd(15)} ${s.label.padEnd(12)} ${s.probability.toFixed(2)}  ${String(s.kept).padEnd(5)} ${s.field} = ${JSON.stringify(s.value)}`
      );
    }

    for (const fieldType of ['quoted', 'classification', 'all'] as const) {
      const group = fieldType === 'all' ? scored : scored.filter((s) => s.fieldType === fieldType);
      lines.push('');
      lines.push(`## ${fieldType}`);
      lines.push(`supported:   ${spread(group.filter((s) => s.label === 'supported').map((s) => s.probability))}`);
      lines.push(`unsupported: ${spread(group.filter((s) => s.label === 'unsupported').map((s) => s.probability))}`);
      for (const t of SWEEP) {
        const { falseDrops, falseKeeps } = errorsAt(group, t);
        lines.push(
          `threshold ${t.toFixed(1)}: ${falseDrops.length} correct dropped [${falseDrops.map((s) => s.id).join(' ')}], ${falseKeeps.length} wrong kept [${falseKeeps.map((s) => s.id).join(' ')}]`
        );
      }
    }
    console.log(lines.join('\n'));

    const out = process.env.EVIDENCE_LIVE_OUT;
    if (out) writeFileSync(out, JSON.stringify({ calls, threshold, scored }, null, 2));

    expect(scored).toHaveLength(set.findings.length);
  });
});
