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

/** A character of a local part: any letter, combining mark or digit, and `.`, `_`, `%`, `+`, `-`. */
const LOCAL_CHAR = String.raw`[\p{L}\p{M}\p{N}._%+\-]`;

/** A character of a domain label: any letter, combining mark or digit. */
const LABEL_CHAR = String.raw`[\p{L}\p{M}\p{N}]`;

/**
 * An address's local part, `@` (or its URL encoding `%40`), then its domain.
 *
 * - Unicode (`u` flag): `josé@acme.com` and `jürgen@bücher.de` match. An
 *   apostrophe (`'` or `’`) counts when it sits between two local-part
 *   characters, so `o'brien@acme.com` is masked whole.
 * - Linear time. A match starts only where a run of local-part characters
 *   starts (the lookbehind rejects every other position at once), so each run
 *   is read once, forwards and back, however long it is; the domain's
 *   quantifiers are bounded (a label is at most 63 characters, a domain at most
 *   127 labels). The previous, unanchored pattern re-read the run from every
 *   position in it, which took 300-750 ms on a 16,000-character string.
 * - A run is masked whole, even past the 64 characters a local part may have.
 * - The local part never contains `*`, so a masked address does not match again.
 */
const EMAIL = new RegExp(
  String.raw`(?<!${LOCAL_CHAR}|${LOCAL_CHAR}['’])(?:${LOCAL_CHAR}|(?<=${LOCAL_CHAR})['’](?=${LOCAL_CHAR}))+(@|%40)` +
    String.raw`((?:${LABEL_CHAR}(?:[\p{L}\p{M}\p{N}\-]{0,61}${LABEL_CHAR})?\.){1,127}\p{L}{2,63})`,
  'gu'
);

/**
 * The end Mastra's serializer puts on a string it cut to
 * `serializationOptions.maxStringLength` (`truncateString` in
 * `@mastra/observability`). The cut happens when the span records the value,
 * before any span output processor runs, so an address can be split by it.
 */
const TRUNCATED = '…[truncated]';

/**
 * The last word before a cut: local-part characters, apostrophes and `@`, at
 * most as long as a whole address. `*` is not in it, so a masked tail is left
 * alone on the next export.
 */
const CUT_TAIL = /[\p{L}\p{M}\p{N}._%+\-'’@]+$/u;

/** The longest address: a 64-character local part, `%40` and a 253-character domain. */
const MAX_ADDRESS = 64 + 3 + 253;

/**
 * Masks the word a cut string ends with, which may be the start of an address
 * whose `@` or domain was cut off (`… jane.do…[truncated]`). What precedes the
 * first `@` or `%40` of that word is masked; a word without one is masked whole,
 * since the cut may have fallen before its `@`. An address the cut left whole,
 * or one already masked, is not changed here.
 */
function maskCutTail(text: string): string {
  if (!text.endsWith(TRUNCATED)) return text;
  const head = text.slice(0, -TRUNCATED.length);
  const tail = head.slice(-MAX_ADDRESS).match(CUT_TAIL)?.[0];
  if (!tail) return text;

  const at = tail.search(/@|%40/);
  const local = at === -1 ? tail : tail.slice(0, at);
  if (!local) return text;
  return `${head.slice(0, head.length - tail.length)}***${tail.slice(local.length)}${TRUNCATED}`;
}

/**
 * `hello@firecrawl.dev` → `***@firecrawl.dev`, and the last word of a string
 * Mastra cut is masked the same way (see {@link maskCutTail}).
 *
 * @public Tests check the pattern with it.
 */
export function maskEmails(text: string): string {
  const masked = text.includes('@') || text.includes('%40') ? text.replace(EMAIL, '***$1$2') : text;
  return maskCutTail(masked);
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
