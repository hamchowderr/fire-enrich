/**
 * Evidence-support check: does a finding's quote support its value?
 *
 * {@link checkFindings} (mappers.ts) only proves a quote came from a page the
 * group's tools read. This check asks an evaluation model the next question:
 * does that quote back the value for that field? It runs after
 * `checkFindings` in the research step, once per finding with a value, all of
 * a group's calls in parallel. A finding whose probability of support is below
 * the threshold is turned into "no value" exactly as `checkFindings` does for a
 * finding with no read evidence, so the UI shows it as unknown.
 *
 * The model is TypeSafe's Jev on the Vercel AI Gateway
 * (`gateway.evaluationModel('typesafe-ai/jev')`), authenticated like every
 * other gateway call. The AI SDK evaluation API is experimental.
 *
 * ## Configuration
 *
 * Read from the environment on every call, like the other switches in this app:
 *
 * - `EVIDENCE_CHECK`: off by default. `1`, `true`, `on`, `yes` or `enabled`
 *   turns the check on; `0`, `false`, `off`, `no` or `disabled` turns it off
 *   (trimmed, any case). An empty or unrecognised value uses the default.
 *   Turning it on by default waits for a check of the question on held-out
 *   findings (tests/evidence).
 * - Cost: when on, each finding with a value is one paid gateway call per
 *   run, and a failing or slow call can add up to the 3 s timeout per group.
 * - `EVIDENCE_CHECK_THRESHOLD`: the probability a finding needs to be kept,
 *   in [0, 1]. Default 0.5; anything unparsable or out of range uses it.
 *
 * ## Failure
 *
 * The check fails open. A classifier error or a call that exceeds the timeout
 * keeps the finding unchecked and logs one warning line for the group, so an
 * outage never blanks a row. A cancelled run makes no further calls and keeps
 * what it has without a warning.
 */
import { gateway } from '@ai-sdk/gateway';
import { Classifier } from '@mastra/core/classifier';

import { unsupportedFinding } from './mappers';
import type { FindingType } from './schemas';

/**
 * Gateway id of the evaluation model. `jev-latest` is the direct-provider id.
 *
 * @public The live measurement (tests/evidence) builds its model from it.
 */
export const EVIDENCE_MODEL_ID = 'typesafe-ai/jev';

const DEFAULT_THRESHOLD = 0.5;

/** Off until the question is checked on held-out findings (tests/evidence). */
const DEFAULT_ENABLED = false;

const ON_VALUES = new Set(['1', 'true', 'on', 'yes', 'enabled']);
const OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);

function parseSwitch(value: string | undefined): boolean {
  const flag = value?.trim().toLowerCase() ?? '';
  if (ON_VALUES.has(flag)) return true;
  if (OFF_VALUES.has(flag)) return false;
  return DEFAULT_ENABLED;
}

/** Per-call budget; the spike measured a median of ~0.35 s. */
const DEFAULT_TIMEOUT_MS = 3_000;

/** One retry on a retryable gateway error, then fail open. */
const MAX_RETRIES = 1;

const QUESTIONS = {
  supported: {
    type: 'boolean',
    instructions:
      'The state holds a data field (its name and description), a value reported for it, and a quote from a web page given as evidence. Does the quote, on its own, support that value for that field? ' +
      'Fields are of two kinds. A factual field (a name, description, number, date, place, amount, URL or job title) is supported only when the quote states the value; rewording and rounding are fine, but a figure for a different quantity is not (one funding round is not total funding, forks are not stars, a copyright year is not a founding year). ' +
      'A classification field (an industry, company type, business model, customer type or pricing model) asks for a category: it is supported when the category is the plain, reasonable reading of the quote, even if the quote does not name the category.',
    criteria: {
      true: 'The quote states the value, or, for a classification field, a reasonable reader would assign that category from the quote alone.',
      false:
        'The quote states a different value, gives a figure for a different quantity, needs facts it does not contain to reach the value, or is about something else.',
    },
  },
} as const;

type EvaluationModel = ConstructorParameters<typeof Classifier<typeof QUESTIONS>>[0]['model'];

/**
 * The evidence-support classifier over a given evaluation model. Tests pass a
 * hand-written model; the app uses {@link evidenceSupportClassifier}.
 *
 * @public Tests build the classifier over a fake evaluation model with it.
 */
export function createEvidenceSupportClassifier(model: EvaluationModel) {
  return new Classifier({ id: 'evidence-support', model, questions: QUESTIONS });
}

/**
 * Registered on the Mastra instance, so its evaluations are traced when
 * observability is configured (e.g. in Studio).
 */
export const evidenceSupportClassifier = createEvidenceSupportClassifier(
  gateway.evaluationModel(EVIDENCE_MODEL_ID)
);

type EvidenceSupportClassifier = ReturnType<typeof createEvidenceSupportClassifier>;

interface EvidenceCheckConfig {
  enabled: boolean;
  threshold: number;
}

/** The check's switch and threshold, read from the environment. */
export function evidenceCheckConfig(env: Readonly<Record<string, string | undefined>> = process.env): EvidenceCheckConfig {
  const raw = env.EVIDENCE_CHECK_THRESHOLD?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;

  return {
    enabled: parseSwitch(env.EVIDENCE_CHECK),
    threshold: Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_THRESHOLD,
  };
}

interface EvidenceCheckOptions {
  classifier: EvidenceSupportClassifier;
  threshold: number;
  /** Field name to description, for the model's state. */
  fieldDescriptions: ReadonlyMap<string, string>;
  /** Names the group in the warning line. */
  groupId: string;
  /** The run's signal: once it fires, no further calls are made. */
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

type Outcome = { kind: 'kept' } | { kind: 'dropped'; probability: number } | { kind: 'failed'; error: unknown };

function hasValue(finding: FindingType): boolean {
  return finding.value !== null && finding.value !== undefined && finding.evidence.length > 0;
}

/** Settle with the promise, or reject as soon as the signal fires. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Keep each finding whose quote supports its value; turn the rest into "no
 * value", as `checkFindings` does. Findings without a value pass through
 * without a call.
 *
 * Returns the findings in their original order and a note per dropped finding.
 */
export async function checkEvidenceSupport(
  findings: readonly FindingType[],
  options: EvidenceCheckOptions
): Promise<{ findings: FindingType[]; notes: string[] }> {
  const { classifier, threshold, fieldDescriptions, groupId, abortSignal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (abortSignal?.aborted) return { findings: [...findings], notes: [] };

  const outcomes = await Promise.all(
    findings.map(async (finding): Promise<Outcome> => {
      if (!hasValue(finding)) return { kind: 'kept' };

      const signal = abortSignal
        ? AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);

      try {
        const result = await untilAborted(
          classifier.evaluate({
            state: {
              field: finding.field,
              fieldDescription: fieldDescriptions.get(finding.field) ?? '',
              value: finding.value,
              quote: finding.evidence.map((item) => item.quote).join('\n'),
            },
            abortSignal: signal,
            maxRetries: MAX_RETRIES,
          }),
          signal
        );
        const probability = result.answers.supported.probability;
        return probability >= threshold ? { kind: 'kept' } : { kind: 'dropped', probability };
      } catch (error) {
        return { kind: 'failed', error };
      }
    })
  );

  const checked: FindingType[] = [];
  const notes: string[] = [];
  const failures: string[] = [];

  findings.forEach((finding, index) => {
    const outcome = outcomes[index];
    if (outcome.kind === 'dropped') {
      notes.push(
        `"${finding.field}": the quoted evidence did not support the value (evidence check, p=${outcome.probability.toFixed(2)}), so it is unknown.`
      );
      checked.push(unsupportedFinding(finding));
      return;
    }
    if (outcome.kind === 'failed') failures.push(`${finding.field} (${describeError(outcome.error)})`);
    checked.push(finding);
  });

  // A cancelled run is not an outage: nothing to warn about.
  if (failures.length > 0 && !abortSignal?.aborted) {
    console.warn(
      `[EVIDENCE] group "${groupId}": evidence check failed for ${failures.length} finding(s), kept unchecked: ${failures.join('; ')}`
    );
  }

  return { findings: checked, notes };
}
