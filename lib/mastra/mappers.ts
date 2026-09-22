/**
 * Pure mappings between what the research agent returns and what the rest of
 * the app reads.
 *
 * Two jobs, both deliberately free of Mastra so they can be unit tested:
 *
 * - {@link checkFindings} holds a group's findings to the evidence rule. A
 *   quote only counts when its url is one the group's tools actually read; a
 *   finding left with no such quote becomes `null`. The model is told the rule,
 *   and this is where it is enforced.
 * - {@link toEnrichments} turns the checked findings into the
 *   `Record<string, EnrichmentResult>` the UI renders (`lib/types`), in the
 *   shape the legacy orchestrator produced. A field with no finding is left
 *   out of the record, which is how the UI already shows "unknown", and listed
 *   in `unknown` with the reason.
 */
import type { EnrichmentResult } from '@/lib/types';

import type { ResearchStrategy } from './agents/research-context';
import type { EnrichFieldDefinitionType, FindingType } from './schemas';

/** A research group's outcome, as the workflow's research steps return it. */
export interface GroupResult {
  groupId: string;
  strategy: ResearchStrategy;
  fieldNames: string[];
  findings: FindingType[];
  notes: string;
  structuredOutputFailed: boolean;
}

/**
 * Comparable form of a url: lowercase host without `www.`, no hash, no
 * trailing slash. Anything that does not parse is compared as trimmed text.
 */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${host}${path}${parsed.search}`;
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Enforce the evidence rule on one group's findings.
 *
 * - findings for fields the group was not asked for are dropped;
 * - a duplicate finding for a field keeps the first;
 * - evidence whose url is not in `readUrls` is dropped;
 * - a non-null value left with no evidence becomes `null`, with a note.
 *
 * Returns the checked findings and the notes explaining what was removed.
 */
export function checkFindings(
  findings: readonly FindingType[],
  fieldNames: readonly string[],
  readUrls: Iterable<string>
): { findings: FindingType[]; notes: string[] } {
  const allowed = new Set(fieldNames);
  const read = new Set([...readUrls].map(normalizeUrl));
  const seen = new Set<string>();
  const checked: FindingType[] = [];
  const notes: string[] = [];

  for (const finding of findings) {
    if (!allowed.has(finding.field)) {
      notes.push(`Dropped a finding for "${finding.field}", which this group was not asked for.`);
      continue;
    }
    if (seen.has(finding.field)) continue;
    seen.add(finding.field);

    const evidence = (finding.evidence ?? []).filter((item) => read.has(normalizeUrl(item.url)));
    const dropped = (finding.evidence ?? []).length - evidence.length;
    if (dropped > 0) {
      notes.push(`"${finding.field}": dropped ${dropped} quote(s) citing a url no tool read in this group.`);
    }

    if (finding.value !== null && finding.value !== undefined && evidence.length === 0) {
      notes.push(`"${finding.field}": the value had no evidence from a page read in this group, so it is unknown.`);
      checked.push({ ...finding, value: null, confidence: 0, evidence: [] });
      continue;
    }

    checked.push({ ...finding, evidence });
  }

  return { findings: checked, notes };
}

type EnrichmentValue = EnrichmentResult['value'];

/**
 * Coerce a finding value to the field's declared type where that is lossless;
 * otherwise keep what the model wrote, so a value is never silently changed.
 */
function coerce(value: NonNullable<FindingType['value']>, type: EnrichFieldDefinitionType['type']): EnrichmentValue {
  switch (type) {
    case 'number': {
      if (typeof value === 'number') return value;
      if (typeof value === 'string') {
        const trimmed = value.trim().replace(/,/g, '');
        if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
      }
      return Array.isArray(value) ? value : String(value);
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (lower === 'true' || lower === 'yes') return true;
        if (lower === 'false' || lower === 'no') return false;
      }
      return Array.isArray(value) ? value : String(value);
    }
    case 'array':
      return Array.isArray(value) ? value : [String(value)];
    default:
      return Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : String(value);
  }
}

/** One finding as the `EnrichmentResult` the UI reads. */
function toEnrichmentResult(finding: FindingType, field: EnrichFieldDefinitionType): EnrichmentResult {
  const value = coerce(finding.value as NonNullable<FindingType['value']>, field.type);
  const evidence = finding.evidence.map((item) => ({ ...item, confidence: clamp01(item.confidence) }));

  return {
    field: field.name,
    value,
    confidence: clamp01(finding.confidence),
    source: evidence[0]?.url,
    sourceContext: evidence.map((item) => ({ url: item.url, snippet: item.quote })),
    sourceCount: new Set(evidence.map((item) => normalizeUrl(item.url))).size,
    corroboration: {
      evidence: evidence.map((item) => ({
        value,
        source_url: item.url,
        exact_text: item.quote,
        confidence: item.confidence,
      })),
      sources_agree: finding.sourcesAgree,
    },
  };
}

/**
 * Build the row's enrichments from every group's checked findings.
 *
 * Every requested field ends up in exactly one of the two outputs: in
 * `enrichments` with a value and its evidence, or in `unknown` with the reason
 * it has none. Nothing is filled in from outside the findings.
 */
export function toEnrichments(
  fields: readonly EnrichFieldDefinitionType[],
  groups: readonly GroupResult[]
): { enrichments: Record<string, EnrichmentResult>; unknown: Array<{ field: string; reason: string }> } {
  const enrichments: Record<string, EnrichmentResult> = {};
  const unknown: Array<{ field: string; reason: string }> = [];

  for (const field of fields) {
    // A plan that names a field in two groups gets the first group's finding,
    // even when that one is null and a later group found a value. Known
    // limitation, to be fixed by preferring the best-supported finding.
    const group = groups.find((candidate) => candidate.fieldNames.includes(field.name));

    if (!group) {
      unknown.push({ field: field.name, reason: 'No research group in the plan covers this field.' });
      continue;
    }

    const finding = group.findings.find((candidate) => candidate.field === field.name);

    if (finding && finding.value !== null && finding.value !== undefined && finding.evidence.length > 0) {
      enrichments[field.name] = toEnrichmentResult(finding, field);
      continue;
    }

    const reason = group.structuredOutputFailed
      ? `Research group "${group.groupId}" did not return a valid result.`
      : finding
        ? `No evidence found by research group "${group.groupId}".`
        : `Research group "${group.groupId}" returned no finding for this field.`;

    unknown.push({ field: field.name, reason: group.notes ? `${reason} ${group.notes}` : reason });
  }

  return { enrichments, unknown };
}
