/**
 * Tracing: every workflow run, agent call, tool call and evidence-support
 * check is recorded as spans in Mastra's own storage, the same libSQL database
 * (Turso, or the local file) that `storage` in `index.ts` points at. The spans
 * go to the `mastra_ai_spans` table, which the store creates at init whether or
 * not tracing is on. Studio (`npm run studio`) reads them from there.
 *
 * ## What a span stores
 *
 * Its input and output (prompts, tool arguments and results, the workflow's
 * input and output), metadata and attributes, with these limits:
 *
 * - Email addresses are masked to `***@domain` (`emailRedactor`, `span-processors.ts`), and
 *   Mastra's default `SensitiveDataFilter` redacts keys such as `apiKey`.
 * - Page text from the Firecrawl tools is cut to 2,000 characters per page
 *   (`pageTextLimiter`); any other string to {@link MAX_TRACED_STRING}.
 * - Per-chunk model spans (`MODEL_CHUNK`) are not recorded.
 * - Spans older than `TRACING_RETENTION_DAYS` are deleted (`lib/flush-traces.ts`).
 *
 * ## Configuration
 *
 * Read from the environment when the Mastra instance is built:
 *
 * - `TRACING`: `0`, `false`, `off`, `no` or `disabled` turns tracing off. On
 *   by default.
 * - `TRACING_SAMPLE_RATE`: the share of traces kept, in [0, 1]. Default 1
 *   (every trace); anything unparsable or out of range uses it. Sampling is
 *   decided per trace, at its root span, so a kept trace is always complete.
 * - `TRACING_RETENTION_DAYS`: days a span is kept. Default 14; `0` keeps spans
 *   forever; anything unparsable or negative uses 14.
 *
 * ## Flushing
 *
 * The exporter buffers spans and writes them in batches (at most 5 s apart).
 * A serverless function can be frozen as soon as its response ends, so a route
 * that runs agents or workflows calls `flushTracesAfter` (`lib/flush-traces.ts`)
 * to write the buffer inside Next.js `after()`, once its work is done. The
 * response is never held for it. That helper lives outside `lib/mastra` so
 * Studio's bundle of this directory never pulls in Next.js.
 */
import { SamplingStrategyType, SpanType, type SamplingStrategy } from '@mastra/core/observability';
import type { RetentionConfig } from '@mastra/core/storage';
import { MastraStorageExporter, Observability } from '@mastra/observability';

import { emailRedactor, pageTextLimiter } from './span-processors';

const SERVICE_NAME = 'fire-enrich';

const DEFAULT_SAMPLE_RATE = 1;

const DEFAULT_RETENTION_DAYS = 14;

/**
 * The longest string any span keeps, in characters (Mastra's default is
 * 131,072). Prompts are a few thousand characters; this bounds what is left,
 * such as the chat panel's table dump or a long tool result.
 */
const MAX_TRACED_STRING = 16_000;

/** Values of `TRACING` that turn it off, compared trimmed and lower-cased. */
const OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);

interface TracingConfig {
  enabled: boolean;
  sampleRate: number;
  /** Days a span is kept; 0 keeps spans forever. */
  retentionDays: number;
}

/**
 * The tracing switch, sample rate and retention, read from the environment.
 *
 * @public Tests read it with a given environment.
 */
export function tracingConfig(env: Readonly<Record<string, string | undefined>> = process.env): TracingConfig {
  const flag = env.TRACING?.trim().toLowerCase();
  const rate = parseNumber(env.TRACING_SAMPLE_RATE);
  const days = parseNumber(env.TRACING_RETENTION_DAYS);

  return {
    enabled: !OFF_VALUES.has(flag ?? ''),
    sampleRate: rate !== undefined && rate >= 0 && rate <= 1 ? rate : DEFAULT_SAMPLE_RATE,
    retentionDays: days !== undefined && days >= 0 ? days : DEFAULT_RETENTION_DAYS,
  };
}

function parseNumber(raw: string | undefined): number | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

function sampling(rate: number): SamplingStrategy {
  if (rate >= 1) return { type: SamplingStrategyType.ALWAYS };
  if (rate <= 0) return { type: SamplingStrategyType.NEVER };
  return { type: SamplingStrategyType.RATIO, probability: rate };
}

/**
 * The store's `retention` for spans: `TRACING_RETENTION_DAYS`, or none (kept
 * forever) at 0. Applied by `storage.prune()`, which `lib/flush-traces.ts` runs.
 * Set whether or not tracing is on, so spans recorded before tracing was turned
 * off still expire.
 */
export function tracingRetention(config: TracingConfig = tracingConfig()): RetentionConfig | undefined {
  if (config.retentionDays <= 0) return undefined;
  return { observability: { spans: { maxAge: `${config.retentionDays}d` } } };
}

/**
 * The Mastra instance's `observability`, or undefined when tracing is off (the
 * instance then records nothing).
 */
export function createObservability(config: TracingConfig = tracingConfig()): Observability | undefined {
  if (!config.enabled) return undefined;

  return new Observability({
    configs: {
      default: {
        serviceName: SERVICE_NAME,
        sampling: sampling(config.sampleRate),
        exporters: [new MastraStorageExporter()],
        // One span per streamed model chunk: about two thirds of a row's
        // spans, with nothing the model step and generation spans above them
        // do not already hold. They are leaves, so no span loses its parent.
        excludeSpanTypes: [SpanType.MODEL_CHUNK],
        serializationOptions: { maxStringLength: MAX_TRACED_STRING },
        // Run on every span before it is stored. Mastra adds its default
        // SensitiveDataFilter (API keys, tokens, passwords) as well.
        spanOutputProcessors: [emailRedactor(), pageTextLimiter()],
      },
    },
  });
}
