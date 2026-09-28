/**
 * Span output processors: they change what a trace stores, never what the app
 * does. Mastra runs them on each span before every export (start, update, end),
 * on the span's own copies of its data (`deepClean` copies input, output,
 * metadata and attributes when they are set), so a processor that replaces
 * those fields cannot reach the workflow's or the agent's values.
 *
 * - {@link emailRedactor} masks email addresses.
 * - {@link pageTextLimiter} cuts page text read by the Firecrawl tools.
 *
 * They are plain `SpanOutputProcessor` objects: Mastra calls `process` and
 * `shutdown`, which a class's members would hide from the dead-code gate.
 *
 * Both are idempotent: running one twice on a span stores the same thing.
 */
import type { AnySpan, SpanOutputProcessor } from '@mastra/core/observability';

/** The span fields a processor rewrites; the same set `SensitiveDataFilter` covers. */
const FIELDS = ['input', 'output', 'metadata', 'attributes', 'errorInfo', 'requestContext'] as const;

type Rewrite = (value: string, key: string | undefined) => string;

/**
 * A copy of `value` with every string, and every object key, passed through
 * `rewrite`. Strings get the key they sit under (undefined in an array or at
 * the top). Values other than plain objects, arrays and strings are kept.
 */
function mapStrings(value: unknown, rewrite: Rewrite, key?: string, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return rewrite(value, key);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';

  if (Array.isArray(value)) {
    seen.add(value);
    const copy = value.map((item) => mapStrings(item, rewrite, undefined, seen));
    seen.delete(value);
    return copy;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;

  seen.add(value);
  const copy: Record<string, unknown> = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    copy[rewrite(entryKey, undefined)] = mapStrings(entry, rewrite, entryKey, seen);
  }
  seen.delete(value);
  return copy;
}

function rewriteSpan(span: AnySpan, rewrite: Rewrite): void {
  const fields = span as unknown as Record<(typeof FIELDS)[number], unknown>;
  for (const field of FIELDS) {
    if (fields[field] !== undefined) fields[field] = mapStrings(fields[field], rewrite);
  }
}

/**
 * An address's local part, `@` (or its URL encoding `%40`), then its domain.
 * The local part never contains `*`, so a masked address does not match again.
 */
const EMAIL = /[A-Za-z0-9._%+-]+(@|%40)((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63})/g;

/**
 * `hello@firecrawl.dev` → `***@firecrawl.dev`.
 *
 * @public Tests check the pattern with it.
 */
export function maskEmails(text: string): string {
  return text.includes('@') || text.includes('%40') ? text.replace(EMAIL, '***$1$2') : text;
}

/**
 * Masks the local part of every email address in a span's strings (prompts,
 * tool arguments and results, the workflow's input and output, metadata) and
 * object keys, keeping the domain: `hello@firecrawl.dev` becomes
 * `***@firecrawl.dev`.
 *
 * The local part is the personal part (often a name) and is masked whole: one
 * kept letter would not tell two rows apart, and the row index is on the
 * workflow span for that. The domain is kept because it names the company the
 * row was about, which the same trace already holds as the company's website.
 * Addresses printed on the pages the tools read are masked the same way.
 */
export function emailRedactor(): SpanOutputProcessor {
  return {
    name: 'email-redactor',
    process(span) {
      if (span) rewriteSpan(span, maskEmails);
      return span;
    },
    async shutdown() {},
  };
}

/**
 * The longest page text a trace keeps from a Firecrawl tool result, in
 * characters. The tools hand the model up to 40,000 characters per scraped page
 * and 8,000 per search call; the trace keeps the start of each page, enough to
 * see which page was read and what it opened with.
 *
 * @public Tests check the cut against it.
 */
export const TRACED_PAGE_CHARS = 2_000;

/** Ends a string this processor already cut, so a later export leaves it alone. */
const CUT_NOTE = /… \[page text cut for the trace: \d+ chars\]$/;

/**
 * Cuts every string stored under a `markdown` key, the page text the
 * `firecrawl-search` and `firecrawl-scrape` tools return, to
 * {@link TRACED_PAGE_CHARS}, noting the full length. This covers the tool-call
 * spans and any other span that carries the tool results (agent output, memory).
 */
export function pageTextLimiter(maxChars = TRACED_PAGE_CHARS): SpanOutputProcessor {
  return {
    name: 'page-text-limiter',
    process(span) {
      if (span) {
        rewriteSpan(span, (value, key) =>
          key === 'markdown' && value.length > maxChars && !CUT_NOTE.test(value)
            ? `${value.slice(0, maxChars)}… [page text cut for the trace: ${value.length} chars]`
            : value
        );
      }
      return span;
    },
    async shutdown() {},
  };
}
