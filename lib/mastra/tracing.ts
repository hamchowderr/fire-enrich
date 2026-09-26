/**
 * Tracing: every workflow run, agent call, tool call and evidence-support
 * check is recorded as spans in Mastra's own storage, the same libSQL database
 * (Turso, or the local file) that `storage` in `index.ts` points at. The spans
 * go to the `mastra_ai_spans` table, which the store creates at init whether or
 * not tracing is on. Studio (`npm run studio`) reads them from there.
 *
 * ## Configuration
 *
 * Read from the environment when the Mastra instance is built:
 *
 * - `TRACING`: `0`, `false` or `off` turns tracing off. On by default.
 * - `TRACING_SAMPLE_RATE`: the share of traces kept, in [0, 1]. Default 1
 *   (every trace); anything unparsable or out of range uses it. Sampling is
 *   decided per trace, at its root span, so a kept trace is always complete.
 *
 * Per-chunk model spans (`MODEL_CHUNK`) are not recorded, to limit storage.
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
import { MastraStorageExporter, Observability } from '@mastra/observability';

const SERVICE_NAME = 'fire-enrich';

const DEFAULT_SAMPLE_RATE = 1;

interface TracingConfig {
  enabled: boolean;
  sampleRate: number;
}

/**
 * The tracing switch and sample rate, read from the environment.
 *
 * @public Tests read it with a given environment.
 */
export function tracingConfig(env: Readonly<Record<string, string | undefined>> = process.env): TracingConfig {
  const flag = env.TRACING?.trim().toLowerCase();
  const raw = env.TRACING_SAMPLE_RATE?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;

  return {
    enabled: flag !== '0' && flag !== 'false' && flag !== 'off',
    sampleRate: Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_SAMPLE_RATE,
  };
}

function sampling(rate: number): SamplingStrategy {
  if (rate >= 1) return { type: SamplingStrategyType.ALWAYS };
  if (rate <= 0) return { type: SamplingStrategyType.NEVER };
  return { type: SamplingStrategyType.RATIO, probability: rate };
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
      },
    },
  });
}
