/**
 * `enrichRow`: one CSV row, from a contact email to evidence-backed fields.
 *
 * ```
 * resolve-plan ─▶ identify ─▶ map: one item per non-browser group ─▶ foreach(research-group, concurrency 2)
 *          ─▶ map: one item per browser group     ─▶ foreach(research-browser-group, concurrency 1)
 *          ─▶ finalize
 * ```
 *
 * The plan normally arrives as data (`EnrichRowInput.plan`), resolved by the
 * caller. When it is omitted, the first step resolves it from the field set
 * with `plan-fallback.ts`: a cached plan that covers the fields, else one the
 * planner writes for them. Nothing here holds a query: the queries are the
 * plan's, with `{company}` and `{domain}` filled from what the identify step
 * found.
 *
 * ## Why browser groups run in a pass of their own
 *
 * The browser agent drives one shared hosted session (`scope: 'shared'` in
 * `agents/browser.ts`); two groups driving it at once would click over each
 * other. Search and agent groups have no such constraint, so the groups are
 * partitioned: every non-browser group runs first, two at a time, then the
 * browser groups run one at a time in a second `.foreach` with concurrency 1.
 * Browser groups go last because they are the slowest and most expensive tier;
 * a run cancelled part-way has then already spent its budget on the cheap ones.
 *
 * ## Stream events
 *
 * Every research step forwards the Firecrawl tools' `firecrawl-progress`
 * events onto the step writer (with `groupId` added), and writes one
 * `evidence` event per quote that survived the evidence check. Both reach a
 * `run.stream()` consumer as `workflow-step-output` chunks.
 */
import { RequestContext } from '@mastra/core/request-context';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { RESEARCH_MODEL_KEY, RESEARCH_STRATEGY_KEY } from '../agents/research-context';
import { checkFindings, toEnrichments, type GroupResult } from '../mappers';
import { restrictPlan } from '../plan-cache';
import { resolvePlan } from '../plan-fallback';
import {
  CompanyContext,
  EnrichFieldDefinition,
  EnrichRowInput,
  EnrichRowOutput,
  PhaseOutput,
  ResearchPlan,
  type CompanyContextType,
  type EnrichRowInputType,
  type PhaseOutputType,
  type ResearchGroupType,
} from '../schemas';
import { isFirecrawlProgressEvent, type FirecrawlProgressEvent } from '../tools';
import { isBlockedUrl } from '../tools/filters';

/** Concurrency of the non-browser research pass. */
const RESEARCH_CONCURRENCY = 2;

/** Model turns a research call may take; tool calls count as turns. */
const MAX_STEPS: Record<ResearchGroupType['strategy'], number> = {
  search: 10,
  agent: 10,
  browser: 14,
};

/** Model turns the identify call may take. */
const IDENTIFY_MAX_STEPS = 6;

/**
 * One evidence quote, written to the step stream as the research step accepts it.
 *
 * @public Part of the workflow's stream contract; the SSE adapter reads it.
 */
export interface EvidenceEvent {
  type: 'evidence';
  groupId: string;
  field: string;
  url: string;
  quote: string;
}

/**
 * What a research step writes to its stream.
 *
 * @public Part of the workflow's stream contract; the SSE adapter reads it.
 */
export type EnrichRowStreamEvent = EvidenceEvent | FirecrawlProgressEvent;

const WorkflowState = z.object({
  company: CompanyContext.optional(),
});

/** The run input once the plan is known, and where the plan came from. */
const ResolvedInput = EnrichRowInput.extend({
  plan: ResearchPlan,
  planSource: EnrichRowOutput.shape.planSource,
});

type ResolvedInputType = z.infer<typeof ResolvedInput>;

const GroupSchema = ResearchPlan.shape.groups.element;
const PlannedFieldSchema = ResearchPlan.shape.fields.element;

/** One research group, ready to run for one row. */
const ResearchItem = z.object({
  group: GroupSchema,
  fields: z.array(PlannedFieldSchema),
  companyContext: CompanyContext,
  contact: z.object({ email: z.string(), rowIndex: z.number() }),
  sessionId: z.string(),
  runId: z.string(),
  researchModel: z.string().optional(),
});

type ResearchItemType = z.infer<typeof ResearchItem>;

const GroupResultSchema = z.object({
  groupId: z.string(),
  strategy: z.enum(['search', 'agent', 'browser']),
  fieldNames: z.array(z.string()),
  findings: PhaseOutput.shape.findings,
  notes: z.string(),
  structuredOutputFailed: z.boolean(),
});

/**
 * Returned when a research call does not produce a valid `PhaseOutput`.
 *
 * With `errorStrategy: 'fallback'` Mastra hands back this value instead of
 * throwing, so a group whose output misses the schema degrades to "no
 * findings" and the row still completes. The note doubles as the marker that
 * tells the fallback apart from a genuine empty answer.
 */
const STRUCTURED_OUTPUT_FAILED = 'The research result did not match the expected format, so no findings were kept.';
const NO_FINDINGS: PhaseOutputType = { findings: [], notes: STRUCTURED_OUTPUT_FAILED };

/** Returned when the identify call does not produce a valid `CompanyContext`. */
function unidentified(email: string): CompanyContextType {
  const domain = email.split('@')[1]?.trim().toLowerCase() ?? '';
  return { companyName: '', domain, website: '', description: '', confidence: 0 };
}

function requestContextFor(researchModel: string | undefined, strategy?: ResearchGroupType['strategy']) {
  const requestContext = new RequestContext<Record<string, unknown>>();
  if (researchModel) requestContext.set(RESEARCH_MODEL_KEY, researchModel);
  if (strategy) requestContext.set(RESEARCH_STRATEGY_KEY, strategy);
  return requestContext;
}

/** Fill a plan query's placeholders for this company. */
function fillQuery(query: string, company: CompanyContextType): string {
  const domain = company.domain || company.website.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const name = company.companyName || domain;
  return query.replaceAll('{company}', name).replaceAll('{domain}', domain);
}

/**
 * Walk a stream chunk for Firecrawl progress events.
 *
 * A tool's writes arrive as `tool-output` chunks carrying the event in
 * `payload.output`; a sub-agent's arrive wrapped once more, as the sub-agent's
 * own chunks inside the `agent-browser` tool's output. The walk is bounded.
 */
function progressEventsIn(chunk: unknown, depth = 0): FirecrawlProgressEvent[] {
  if (depth > 6 || typeof chunk !== 'object' || chunk === null) return [];
  if (isFirecrawlProgressEvent(chunk)) return [chunk];

  const payload = (chunk as { payload?: { output?: unknown } }).payload;
  return payload && 'output' in payload ? progressEventsIn(payload.output, depth + 1) : [];
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]}]+/g;

/**
 * The urls a sub-agent's result shows it read: those named in its answer, and
 * the `url` its own tools were called with or returned. Page text inside
 * those tool results is not walked, because a link on a page is not a page
 * that was read.
 */
function subAgentReadUrls(result: unknown): string[] {
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    for (const match of value.match(URL_PATTERN) ?? []) found.add(match.replace(/[.,;:]+$/, ''));
  };

  const { text, subAgentToolResults } = (result ?? {}) as {
    text?: unknown;
    subAgentToolResults?: Array<{ args?: { url?: unknown }; result?: { url?: unknown }; isError?: boolean }>;
  };

  add(text);
  for (const toolResult of subAgentToolResults ?? []) {
    if (toolResult.isError) continue;
    add(toolResult.args?.url);
    add(toolResult.result?.url);
  }

  return [...found];
}

function bulletList(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty;
}

/** The user message for one research call. */
function renderGroupPrompt(item: ResearchItemType, company: CompanyContextType): string {
  const { group, fields, contact } = item;

  const toolNote =
    group.strategy === 'browser'
      ? 'Some of these facts only appear after interacting with a page. Try firecrawl-scrape first; when the page does not show the answer, delegate to agent-browser with the url and exactly what to find.'
      : group.strategy === 'agent'
        ? 'The plan marked these facts as needing several sources reconciled. Hand the question to firecrawl-agent first, with a JSON schema for these fields, and cite the sources it returns; then use firecrawl-scrape on a returned source when a value needs checking.'
        : 'Use firecrawl-search, and firecrawl-scrape or firecrawl-map when you know which site holds the answer.';

  return [
    '## Company',
    `Name: ${company.companyName || '(not identified)'}`,
    `Domain: ${company.domain || '(unknown)'}`,
    `Website: ${company.website || '(unknown)'}`,
    `Description: ${company.description || '(none)'}`,
    `Contact email: ${contact.email}`,
    '',
    `## Research group: ${group.label}`,
    'Fields to fill (use these names in `field`):',
    ...fields.map(
      (field) =>
        `- ${field.name} (${field.type}): ${field.description}` +
        (field.examples.length > 0 ? ` Examples: ${field.examples.join(', ')}.` : '')
    ),
    '',
    'Suggested searches:',
    bulletList(group.queries, '- (none; write your own)'),
    '',
    'Preferred sources:',
    bulletList(group.preferredSources, '- (none named)'),
    '',
    'What counts as evidence for this group:',
    group.instructions || 'A page on or about this company that states the value.',
    '',
    toolNote,
  ].join('\n');
}

const resolvePlanStep = createStep({
  id: 'resolve-plan',
  description: 'Use the plan the run was given, or find one for its fields (cache, then planner).',
  inputSchema: EnrichRowInput,
  outputSchema: ResolvedInput,
  execute: async ({ inputData, mastra, abortSignal }) => {
    if (inputData.plan) return { ...inputData, plan: inputData.plan, planSource: 'input' as const };

    const { plan, source } = await resolvePlan(inputData.fields, {
      planner: mastra.getAgent('planner'),
      abortSignal,
    });
    return { ...inputData, plan, planSource: source };
  },
});

const identifyStep = createStep({
  id: 'identify',
  description: 'Find the company behind the contact email.',
  inputSchema: ResolvedInput,
  outputSchema: CompanyContext,
  stateSchema: WorkflowState,
  execute: async ({ inputData, mastra, setState, abortSignal }) => {
    const agent = mastra.getAgent('identify');
    const email = inputData.email.trim();

    const result = await agent.generate(
      [
        `Email to identify: ${email}`,
        `Email domain: ${email.split('@')[1] ?? '(none)'}`,
        '',
        'Find the company this email belongs to.',
      ].join('\n'),
      {
        requestContext: requestContextFor(inputData.models?.research),
        maxSteps: IDENTIFY_MAX_STEPS,
        abortSignal,
        structuredOutput: {
          schema: CompanyContext,
          errorStrategy: 'fallback',
          fallbackValue: unidentified(email),
        },
      }
    );

    const company = CompanyContext.safeParse(result.object);
    const context = company.success ? company.data : unidentified(email);

    await setState({ company: context });
    return context;
  },
});

/** Research items for the groups selected by `browser`, in plan order. */
function researchItems(
  input: ResolvedInputType,
  company: CompanyContextType,
  runId: string,
  browser: boolean
): ResearchItemType[] {
  const plan = restrictPlan(
    input.plan,
    input.fields.map((field) => field.name)
  );

  return plan.groups
    .filter((group) => (group.strategy === 'browser') === browser)
    .map((group) => ({
      group: { ...group, queries: group.queries.map((query) => fillQuery(query, company)) },
      fields: plan.fields.filter((field) => group.fieldNames.includes(field.name)),
      companyContext: company,
      contact: { email: input.email, rowIndex: input.rowIndex },
      sessionId: input.sessionId,
      runId,
      researchModel: input.models?.research,
    }));
}

/**
 * Research one group. Built twice, under two ids, because a step can appear in
 * a workflow graph only once and the two passes need one each.
 */
function researchGroupStep<TId extends string>(id: TId) {
  return createStep({
    id,
    description: 'Research one group of fields and keep only findings backed by pages the tools read.',
    inputSchema: ResearchItem,
    outputSchema: GroupResultSchema,
    stateSchema: WorkflowState,
    execute: async ({ inputData: item, state, mastra, writer, abortSignal }) => {
      const { group } = item;
      // State is where the identify step left the company; the item carries a
      // copy so a step run on its own (Studio, a test) still has one.
      const company = state.company ?? item.companyContext;
      const agent = mastra.getAgent('research');

      const stream = await agent.stream(renderGroupPrompt(item, company), {
        requestContext: requestContextFor(item.researchModel, group.strategy),
        maxSteps: MAX_STEPS[group.strategy],
        abortSignal,
        // Browser groups need a memory thread for the sub-agent's page tracking
        // (see agents/research.ts). History is not replayed: each group starts
        // clean even though browser groups of one run share the thread.
        ...(group.strategy === 'browser'
          ? {
              memory: {
                thread: item.runId,
                resource: item.sessionId,
                options: { lastMessages: false as const },
              },
            }
          : {}),
        structuredOutput: {
          schema: PhaseOutput,
          errorStrategy: 'fallback',
          fallbackValue: NO_FINDINGS,
        },
      });

      const readUrls = new Set<string>();

      for await (const chunk of stream.fullStream) {
        const type = (chunk as { type?: string }).type;

        if (type === 'tool-output') {
          for (const event of progressEventsIn(chunk)) {
            if (event.sourceUrl && !isBlockedUrl(event.sourceUrl)) readUrls.add(event.sourceUrl);
            await writer.write({ ...event, groupId: group.id } satisfies FirecrawlProgressEvent);
          }
        }

        // What a sub-agent read is only visible in its result: its text names
        // the url, and its own tool results carry the pages.
        if (type === 'tool-result') {
          const payload = (chunk as { payload?: { toolName?: string; result?: unknown; isError?: boolean } })
            .payload;
          if (payload?.toolName?.startsWith('agent-') && !payload.isError) {
            for (const url of subAgentReadUrls(payload.result)) if (!isBlockedUrl(url)) readUrls.add(url);
          }
        }
      }

      const parsed = PhaseOutput.safeParse(await stream.object);
      const output = parsed.success ? parsed.data : NO_FINDINGS;
      const structuredOutputFailed = !parsed.success || output.notes === STRUCTURED_OUTPUT_FAILED;

      const checked = checkFindings(output.findings, group.fieldNames, readUrls);

      for (const finding of checked.findings) {
        for (const evidence of finding.evidence) {
          await writer.write({
            type: 'evidence',
            groupId: group.id,
            field: finding.field,
            url: evidence.url,
            quote: evidence.quote,
          } satisfies EvidenceEvent);
        }
      }

      return {
        groupId: group.id,
        strategy: group.strategy,
        fieldNames: group.fieldNames,
        findings: checked.findings,
        notes: [output.notes, ...checked.notes].filter(Boolean).join(' '),
        structuredOutputFailed,
      };
    },
  });
}

const researchStep = researchGroupStep('research-group');
const researchBrowserStep = researchGroupStep('research-browser-group');

const finalizeStep = createStep({
  id: 'finalize',
  description: 'Map every group’s findings onto the row’s enrichments; fields with no evidence stay unknown.',
  inputSchema: z.array(GroupResultSchema),
  outputSchema: EnrichRowOutput,
  stateSchema: WorkflowState,
  execute: async ({ inputData: browserResults, getStepResult, state }) => {
    const input = getStepResult(resolvePlanStep);
    const searchResults = (getStepResult(researchStep.id) ?? []) as GroupResult[];
    const groups = [...searchResults, ...browserResults] as GroupResult[];
    const fields = z.array(EnrichFieldDefinition).parse(input.fields);
    const { enrichments, unknown } = toEnrichments(fields, groups);

    return {
      rowIndex: input.rowIndex,
      email: input.email,
      planSource: input.planSource,
      company: state.company ?? unidentified(input.email),
      enrichments,
      unknown,
      groups: groups.map((group) => ({
        groupId: group.groupId,
        strategy: group.strategy,
        fieldNames: group.fieldNames,
        found: group.findings.filter((finding) => finding.value !== null && finding.evidence.length > 0)
          .length,
        structuredOutputFailed: group.structuredOutputFailed,
        notes: group.notes,
      })),
    };
  },
});

export const enrichRowWorkflow = createWorkflow({
  id: 'enrich-row',
  description: 'Enrich one row: identify the company from the email, research each plan group, map findings to fields.',
  inputSchema: EnrichRowInput,
  outputSchema: EnrichRowOutput,
  stateSchema: WorkflowState,
})
  .then(resolvePlanStep)
  .then(identifyStep)
  .map(async ({ inputData, getStepResult, runId }) =>
    researchItems(getStepResult(resolvePlanStep), inputData, runId, false)
  )
  .foreach(researchStep, { concurrency: RESEARCH_CONCURRENCY })
  .map(async ({ getStepResult, runId }) =>
    researchItems(getStepResult(resolvePlanStep), getStepResult(identifyStep), runId, true)
  )
  .foreach(researchBrowserStep, { concurrency: 1 })
  .then(finalizeStep)
  .commit();
