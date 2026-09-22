/**
 * Adapter from the `enrichRow` workflow to the SSE contract of
 * `POST /api/enrich`, which `app/fire-enrich/enrichment-table.tsx` consumes.
 *
 * The UI is unchanged, so everything the workflow streams is translated into
 * the two events it already renders: `agent_progress` lines (with `sourceUrl`
 * for the favicon) and one `result` per row carrying a `RowEnrichmentResult`.
 *
 * | workflow stream                           | SSE `agent_progress`                                 |
 * | ----------------------------------------- | ---------------------------------------------------- |
 * | `workflow-step-start` of `identify`       | info  "Identifying company from {domain}"            |
 * | `workflow-step-result` of `identify`      | success "Identified {company} ({website})" / warning |
 * | step output `group-start`                 | agent "{label}: searching" + target fields           |
 * | step output `firecrawl-progress`          | info  {message}, with `sourceUrl`                    |
 * | step output `evidence`                    | success "{field}: evidence from {host}", `sourceUrl` |
 * | step output `page-read`                   | none; adds the url to the run's visited set           |
 * | step output `group-complete`              | success "{label} complete: N fields" / warning       |
 * | anything else (text deltas, step chunks)  | ignored                                              |
 *
 * The awaited run result becomes the row's `result`: `success` → `completed`,
 * `failed` → `error`, `canceled` → nothing (the route reports the session as
 * cancelled; rows already sent keep their results).
 *
 * Citations: the workflow only keeps quotes from pages its tools read. The
 * adapter repeats the check against the run's visited set: the `page-read`
 * events, which follow only a successful tool result. Progress `sourceUrl`s
 * do not count (they are written before a fetch, so a failed scrape has one),
 * and neither do evidence urls, which would make the check circular.
 */
import type { CSVRow, EnrichmentResult, RowEnrichmentResult } from '@/lib/types';

import { mastra } from './index';
import { resolvePlan } from './plan-fallback';
import {
  EnrichFieldDefinition,
  type EnrichFieldDefinitionType,
  type EnrichRowInputType,
  type EnrichRowOutputType,
  type ResearchPlanType,
} from './schemas';
import type { EnrichRowStreamEvent } from './workflows/enrich-row';

/** What the route needs from a run to stop it: `Run.cancel()` in @mastra/core 1.67. */
export interface CancellableRun {
  cancel(): Promise<unknown>;
}

export type ProgressType = 'info' | 'success' | 'warning' | 'agent';

/** One `agent_progress` line, before the route adds `type` and `rowIndex`. */
export interface ProgressLine {
  message: string;
  messageType: ProgressType;
  sourceUrl?: string;
}

/** Comparable form of a url for the visited-set check. */
function urlKey(url: string): string {
  try {
    const parsed = new URL(url.trim());
    return `${parsed.hostname.toLowerCase().replace(/^www\./, '')}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * The urls a run's stream showed being read, for the citation filter.
 *
 * @public Exported for the unit tests; `enrichRowWithMastra` is its caller.
 */
export class VisitedUrls {
  private readonly keys = new Set<string>();

  add(url: string | undefined): void {
    if (url) this.keys.add(urlKey(url));
  }

  has(url: string | undefined): boolean {
    return !!url && this.keys.has(urlKey(url));
  }
}

type Chunk = { type?: string; payload?: Record<string, unknown> };

/**
 * Translate one workflow stream chunk into progress lines, recording every
 * url it shows being read. Pure apart from `visited`, so it is unit tested.
 *
 * @public Exported for the unit tests; `enrichRowWithMastra` is its caller.
 */
export function translateChunk(chunk: unknown, email: string, visited: VisitedUrls): ProgressLine[] {
  const { type, payload = {} } = (chunk ?? {}) as Chunk;
  const stepId = (payload.id ?? payload.stepName) as string | undefined;

  if (type === 'workflow-step-start' && stepId === 'identify') {
    return [{ message: `Identifying company from ${email.split('@')[1] ?? email}`, messageType: 'info' }];
  }

  if (type === 'workflow-step-result' && stepId === 'identify') {
    const company = payload.output as { companyName?: string; website?: string } | undefined;
    if (payload.status === 'success' && company?.companyName) {
      return [
        {
          message: `Identified ${company.companyName}${company.website ? ` (${company.website})` : ''}`,
          messageType: 'success',
          sourceUrl: company.website || undefined,
        },
      ];
    }
    return payload.status === 'success'
      ? [{ message: 'Could not identify the company; researching from the email domain', messageType: 'warning' }]
      : [];
  }

  if (type !== 'workflow-step-output') return [];

  const event = payload.output as EnrichRowStreamEvent | undefined;

  switch (event?.type) {
    case 'group-start':
      return [
        {
          message: `${event.label}: searching (${event.fieldNames.join(', ')})`,
          messageType: 'agent',
        },
      ];

    case 'page-read':
      visited.add(event.url);
      return [];

    case 'firecrawl-progress':
      return [{ message: event.message, messageType: 'info', sourceUrl: event.sourceUrl }];

    case 'evidence':
      return [
        {
          message: `${event.field}: evidence from ${hostOf(event.url)}`,
          messageType: 'success',
          sourceUrl: event.url,
        },
      ];

    case 'group-complete':
      if (event.structuredOutputFailed) {
        return [{ message: `${event.label}: the research result was unusable, fields left unknown`, messageType: 'warning' }];
      }
      return event.found > 0
        ? [{ message: `${event.label} complete: ${event.found} field${event.found === 1 ? '' : 's'}`, messageType: 'success' }]
        : [{ message: `${event.label} complete: no fields found`, messageType: 'warning' }];

    default:
      return [];
  }
}

/**
 * Keep only citations the run was seen reading; a field left with none is
 * dropped (unknown), never kept without a source.
 *
 * @public Exported for the unit tests; `enrichRowWithMastra` is its caller.
 */
export function filterCitations(
  enrichments: Record<string, EnrichmentResult>,
  visited: VisitedUrls
): Record<string, EnrichmentResult> {
  const kept: Record<string, EnrichmentResult> = {};

  for (const [name, enrichment] of Object.entries(enrichments)) {
    const sourceContext = (enrichment.sourceContext ?? []).filter((context) => visited.has(context.url));
    if (sourceContext.length === 0) continue;

    const evidence = enrichment.corroboration?.evidence.filter((item) => visited.has(item.source_url));
    kept[name] = {
      ...enrichment,
      source: sourceContext[0].url,
      sourceContext,
      sourceCount: new Set(sourceContext.map((context) => urlKey(context.url))).size,
      ...(enrichment.corroboration && evidence
        ? { corroboration: { ...enrichment.corroboration, evidence } }
        : {}),
    };
  }

  return kept;
}

/**
 * The plan for a session: one resolution shared by every row, from the cache
 * (exact or superset) or, on a miss, from the planner.
 */
export async function resolveSessionPlan(
  fields: readonly unknown[],
  abortSignal?: AbortSignal
): Promise<{ plan: ResearchPlanType; fields: EnrichFieldDefinitionType[] }> {
  const parsed = EnrichFieldDefinition.array().min(1).parse(fields);
  const { plan } = await resolvePlan(parsed, { planner: mastra.getAgent('planner'), abortSignal });
  return { plan, fields: parsed };
}

export interface EnrichRowOptions {
  sessionId: string;
  rowIndex: number;
  row: CSVRow;
  email: string;
  plan: ResearchPlanType;
  fields: EnrichFieldDefinitionType[];
  onProgress: (line: ProgressLine) => void;
  /**
   * The session's active runs. The run is added once it exists and removed
   * when it ends, so a DELETE can `cancel()` whatever is still going.
   */
  runs?: Set<CancellableRun>;
  signal?: AbortSignal;
}

/**
 * Enrich one row through `enrichRow`. Resolves to the row result, or `null`
 * when the run was cancelled.
 */
export async function enrichRowWithMastra({
  sessionId,
  rowIndex,
  row,
  email,
  plan,
  fields,
  onProgress,
  runs,
  signal,
}: EnrichRowOptions): Promise<RowEnrichmentResult | null> {
  if (signal?.aborted) return null;

  const run = await mastra.getWorkflow('enrichRow').createRun({
    runId: `${sessionId}-${rowIndex}`,
    resourceId: sessionId,
  });
  runs?.add(run);

  try {
    // A DELETE that landed while the run was being created still stops it.
    if (signal?.aborted) {
      await run.cancel();
      return null;
    }

    const inputData: EnrichRowInputType = { sessionId, rowIndex, email, plan, fields };
    const stream = run.stream({ inputData });
    const visited = new VisitedUrls();

    for await (const chunk of stream.fullStream) {
      for (const line of translateChunk(chunk, email, visited)) onProgress(line);
    }

    const result = await stream.result;

    if (result.status === 'success') {
      const output = result.result as EnrichRowOutputType;
      return {
        rowIndex,
        originalData: row,
        enrichments: filterCitations(output.enrichments as Record<string, EnrichmentResult>, visited),
        status: 'completed',
      };
    }

    // `canceled` is a run status at runtime but missing from the 1.67 result union.
    if ((result.status as string) === 'canceled' || signal?.aborted) return null;

    const error = (result as { error?: unknown }).error;
    return {
      rowIndex,
      originalData: row,
      enrichments: {},
      status: 'error',
      error:
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : (error as { message?: string } | undefined)?.message ?? `Enrichment ${result.status}`,
    };
  } finally {
    runs?.delete(run);
  }
}
