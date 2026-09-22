/**
 * Source filtering shared by every Firecrawl tool.
 *
 * The enrichment pipeline has always refused a handful of domains: their public
 * pages are login walls or bot checks, so a scrape returns chrome rather than
 * facts, and citing one produces a source link a reader cannot open. The rule
 * used to be copy-pasted into five places in
 * `lib/agent-architecture/orchestrator.ts`; it lives here once so the tools, the
 * browser agent, and any later consumer apply the same list.
 */

/**
 * Registrable domains that are never scraped and never cited.
 *
 * `x.com` joins the list that the orchestrator carried because it is the same
 * site as `twitter.com`; the orchestrator predates the rename.
 */
const BLOCKED_DOMAINS = [
  'linkedin.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
] as const;

/** Human-readable list for tool descriptions and agent instructions. */
export const BLOCKED_DOMAINS_LABEL = BLOCKED_DOMAINS.join(', ');

/**
 * True when `url` points at a blocked domain or any of its subdomains.
 *
 * Matching is on the registrable domain rather than the substring test the
 * orchestrator used (`hostname.includes('x.com')`), which also matched
 * `dropbox.com` and `linkedin.com.phish.example`. A `www.` prefix is stripped
 * so `www.twitter.com` and `twitter.com` behave identically.
 *
 * A url that does not parse is *not* treated as blocked — same as the
 * orchestrator's `catch { return true }` branch. An unparseable url fails later
 * on its own, and guessing at its host here would drop good results.
 */
export function isBlockedUrl(url: string | undefined): boolean {
  if (!url) return false;

  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (host.startsWith('www.')) host = host.slice(4);

  return BLOCKED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Split a result list into the items a tool may return and the ones it must drop.
 *
 * Returning both halves rather than just the survivors lets a tool report *how
 * many* sources it withheld, which is the difference between "the web has
 * nothing" and "everything we found was on a blocked site" when a field comes
 * back unknown.
 */
export function splitBlocked<T>(
  items: readonly T[],
  urlOf: (item: T) => string | undefined
): { allowed: T[]; blocked: T[] } {
  const allowed: T[] = [];
  const blocked: T[] = [];

  for (const item of items) {
    (isBlockedUrl(urlOf(item)) ? blocked : allowed).push(item);
  }

  return { allowed, blocked };
}
