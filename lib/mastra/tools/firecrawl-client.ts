/**
 * Shared Firecrawl plumbing for the Mastra tools.
 *
 * Everything here was pulled out of `lib/services/firecrawl.ts`, which each
 * method had its own inline copy of: the same three-attempt exponential
 * backoff, the same list of retryable statuses, the same SSL fallback. The
 * tools need all of it, plus two things the service never had — cancellation
 * and progress reporting — so it lives in one module the tools compose rather
 * than in each tool.
 *
 * ## Cancellation
 *
 * The Firecrawl JS SDK at 4.41.0 accepts no `AbortSignal`: neither
 * `FirecrawlClientOptions` nor any per-call options type carries one, and the
 * string `signal` does not appear in `node_modules/firecrawl/dist/index.js`
 * outside of unrelated prose. So a signal cannot be *forwarded*; it can only be
 * *raced*. {@link raceAbort} rejects as soon as the signal fires, which returns
 * control to the agent immediately, and {@link delay} makes the backoff and
 * poll sleeps abortable so a cancelled run never waits out a retry. The HTTP
 * request already in flight is left to finish and be discarded — that is the
 * ceiling the SDK sets, not a choice made here.
 */
import { Firecrawl } from 'firecrawl';

/** Total attempts per call, matching `FirecrawlService`. */
const MAX_ATTEMPTS = 3;

/** First backoff step; doubles per attempt (1s, 2s). */
const BASE_DELAY_MS = 1_000;

/**
 * Statuses worth another attempt: rate limiting and the gateway's own
 * transient failures. Ported verbatim from `FirecrawlService`.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** Transport failures that surface as a message rather than a status. */
const RETRYABLE_MESSAGES = ['network error', 'server is unreachable'];

/**
 * Discriminator on every progress event written to the tool stream.
 *
 * Module-local until something outside this directory reads it. The SSE adapter
 * that renders these as source lines is the consumer that will want it
 * exported; exporting it before that consumer exists is dead code the gate
 * rightly rejects.
 */
const FIRECRAWL_PROGRESS_TYPE = 'firecrawl-progress';

/**
 * Minimal structural view of the tool writer.
 *
 * `ToolExecutionContext.writer` is a `ToolStream`, but typing against the class
 * would force every test to build one. The tools only ever call `write`, so
 * that is all this asks for.
 */
export interface ProgressWriter {
  write(data: unknown): Promise<void>;
}

/** Shape written for every Firecrawl call so an SSE adapter can render sources. */
interface FirecrawlProgressEvent {
  type: typeof FIRECRAWL_PROGRESS_TYPE;
  message: string;
  sourceUrl?: string;
}

/**
 * Build a Firecrawl client for one tool call.
 *
 * A client is an API key and an axios instance, so building one per call costs
 * nothing next to the request it is about to make, and it keeps the tools free
 * of module-level state that a test would have to reset between cases.
 */
export function firecrawlClient(): Firecrawl {
  const apiKey = process.env.FIRECRAWL_API_KEY;

  if (!apiKey) {
    throw new Error('FIRECRAWL_API_KEY is not set, so the Firecrawl tools cannot run.');
  }

  return new Firecrawl({ apiKey });
}

/** The reason an aborted signal carries, or a standard `AbortError` if it has none. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Reject as soon as `signal` aborts, without waiting for `work` to settle.
 *
 * `work` keeps running; nothing can stop it (see the module comment). The point
 * is that the caller stops *waiting*.
 */
function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });

    const settle = (fn: (value: never) => void) => (value: never) => {
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };

    work.then(settle(resolve as (value: never) => void), settle(reject));
  });
}

/** `setTimeout` that rejects instead of finishing when `signal` aborts. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorStatus(error: unknown): number | undefined {
  return (error as { status?: number })?.status;
}

function errorMessage(error: unknown): string {
  return (error as { message?: string })?.message ?? '';
}

/** Whether another attempt could plausibly succeed. */
function isRetryable(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== undefined && RETRYABLE_STATUSES.has(status)) return true;

  const message = errorMessage(error).toLowerCase();
  return RETRYABLE_MESSAGES.some((fragment) => message.includes(fragment));
}

/**
 * Whether the failure looks like a certificate problem.
 *
 * Ported from `FirecrawlService.scrapeUrl`, which retries such a failure once
 * with `skipTlsVerification`. Kept as a named export so the scrape tool can
 * make that decision explicitly instead of hiding it inside the retry loop —
 * relaxing TLS is a deliberate act, not a backoff step.
 */
export function isSslError(error: unknown): boolean {
  const message = errorMessage(error);

  return (
    message.includes('SSL error') ||
    message.includes('certificate') ||
    (errorStatus(error) === 500 && message.includes('SSL'))
  );
}

export interface RetryOptions {
  /** Cancels the wait between attempts and the wait for the current attempt. */
  signal?: AbortSignal;
  /** Short label used in the retry warning, e.g. `search "acme pricing"`. */
  label: string;
}

/**
 * Run `operation`, retrying transient failures with exponential backoff.
 *
 * Unlike `FirecrawlService.search`, a run that exhausts its attempts throws
 * rather than returning an empty list. A tool that silently answers "nothing
 * found" after three gateway errors teaches the model that the web has no
 * answer, which is the one conclusion it must not draw from an outage; the
 * error reaches the model as a tool failure it can report or route around.
 */
export async function withFirecrawlRetry<T>(
  operation: (attempt: number) => Promise<T>,
  { signal, label }: RetryOptions
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();

    try {
      return await raceAbort(operation(attempt), signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!isRetryable(error) || attempt >= MAX_ATTEMPTS - 1) throw error;

      const wait = BASE_DELAY_MS * 2 ** attempt;
      console.warn(
        `Firecrawl ${label} failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying in ${wait}ms:`,
        errorStatus(error) ?? errorMessage(error)
      );
      await delay(wait, signal);
    }
  }
}

/**
 * Emit one progress event on the tool stream.
 *
 * `sourceUrl` is omitted rather than written as `undefined` so a consumer can
 * test for the key. A write that fails is swallowed: the stream is a side
 * channel for the UI, and a closed one must not turn a successful scrape into a
 * tool error.
 */
export async function reportProgress(
  writer: ProgressWriter | undefined,
  message: string,
  sourceUrl?: string
): Promise<void> {
  if (!writer) return;

  const event: FirecrawlProgressEvent = { type: FIRECRAWL_PROGRESS_TYPE, message };
  if (sourceUrl) event.sourceUrl = sourceUrl;

  try {
    await writer.write(event);
  } catch {
    // A closed or broken stream is not a tool failure.
  }
}
