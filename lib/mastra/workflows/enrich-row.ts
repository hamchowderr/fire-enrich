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
import type { ProcessInputStepArgs, ProcessInputStepResult } from '@mastra/core/processors';
import { RequestContext } from '@mastra/core/request-context';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { RESEARCH_MODEL_KEY, RESEARCH_STRATEGY_KEY } from '../agents/research-context';
import { checkEvidenceSupport, evidenceCheckConfig } from '../evidence-support';
import { checkFindings, toEnrichments, type GroupResult } from '../mappers';
import { restrictPlan } from '../plan-cache';
import { readUrlsFromToolResult } from '../read-urls';
import { resolvePlan } from '../plan-fallback';
import { resolveModel } from '../models';
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

/** Added to the system prompt of a call's last allowed step. */
const LAST_STEP_NOTE =
  'You have no tool calls left. Answer now from the pages you have already read; report a field as not found when they do not support it.';

/**
 * `prepareStep` for a tool loop capped at `maxSteps`: the last allowed step
 * gets no tools (`toolChoice: 'none'`) and a note saying so, so the call ends
 * on an answer rather than on a tool call. The structuring call (see
 * {@link structuredOutputOptions}) runs only when the loop ends on a step that
 * is not a tool call; a loop cut off by `maxSteps` mid-research would
 * otherwise return no object at all.
 *
 * Unverified against Anthropic: for `toolChoice: 'none'` Mastra 1.71
 * (`prepareToolsAndToolChoice`) and `@ai-sdk/anthropic` both send no `tools`,
 * while the history still holds tool_use and tool_result blocks. The first
 * live run must check that a group reaching its last step is accepted.
 */
function answerOnLastStep(maxSteps: number) {
  return ({ stepNumber, systemMessages }: ProcessInputStepArgs): ProcessInputStepResult | undefined =>
    stepNumber >= maxSteps - 1
      ? { toolChoice: 'none', systemMessages: [...systemMessages, { role: 'system', content: LAST_STEP_NOTE }] }
      : undefined;
}

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
 * Written when a research step starts and when it ends.
 *
 * A `.foreach` reports its own start once for the whole pass and each item
 * only once it finishes, so a consumer that wants "group X is searching" needs
 * the step to say so itself.
 */
export interface GroupStartEvent {
  type: 'group-start';
  groupId: string;
  label: string;
  strategy: ResearchGroupType['strategy'];
  fieldNames: string[];
}

export interface GroupCompleteEvent {
  type: 'group-complete';
  groupId: string;
  label: string;
  fieldNames: string[];
  /** Fields that ended with a value backed by evidence. */
  found: number;
  structuredOutputFailed: boolean;
}

/**
 * What a research step writes to its stream.
 *
 * @public Part of the workflow's stream contract; the SSE adapter reads it.
 */
/**
 * A page a tool result shows was read (see read-urls.ts), once per url per
 * group. Unlike `firecrawl-progress`, which is written before a fetch, this
 * only follows a successful read, so it is what citation checks key on.
 */
export interface PageReadEvent {
  type: 'page-read';
  groupId: string;
  url: string;
}

export type EnrichRowStreamEvent =
  | EvidenceEvent
  | PageReadEvent
  | FirecrawlProgressEvent
  | GroupStartEvent
  | GroupCompleteEvent;

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
 * Used when a research call does not produce a valid `PhaseOutput`, so a group
 * whose output misses the schema degrades to "no findings" and the row still
 * completes. The note is text the user sees; the research step detects the
 * failure from the parse of `stream.object`, never from this note, so a model
 * that writes the same words is not a failure.
 */
const STRUCTURED_OUTPUT_FAILED = 'The research result did not match the expected format, so no findings were kept.';
const NO_FINDINGS: PhaseOutputType = { findings: [], notes: STRUCTURED_OUTPUT_FAILED };

/**
 * Structured output for an agent call that uses tools first.
 *
 * `model` puts Mastra in its processor mode: the agent runs its tool loop with
 * no response format, and once the loop ends a separate structuring call turns
 * the whole transcript (tool calls, tool results and the agent's last text)
 * into the schema. Without `model` (direct mode), `@mastra/core` 1.71 checks
 * the text of every model step against the schema, and the first result,
 * valid or not, becomes `stream.object`. A model that writes a sentence before
 * a tool call ("I'll search for ..."), as Claude does, then loses its valid
 * last answer to the fallback value, with `usedFallbackValue` false because
 * only the last result sets it; and a loop that runs out of steps on a tool
 * call has no answer to check at all.
 *
 * The structuring call sees only the transcript, not the user message, so
 * `instructions` (which replace Mastra's generated ones, whose "use reasonable
 * defaults" invites guesses) carry what it needs: the exact field names and
 * the evidence rules. The schema still reaches the model as its native
 * response format.
 *
 * `errorStrategy: 'warn'` logs the validation error (each failing path and
 * why) through the Mastra logger and leaves `stream.object` undefined.
 * `'fallback'` would substitute a value without logging why, which is how a
 * real run lost every reason for its failures. The caller parses
 * `stream.object` and substitutes its own empty value.
 */
function structuredOutputOptions<TSchema extends typeof PhaseOutput | typeof CompanyContext>(
  schema: TSchema,
  researchModel: string | undefined,
  instructions: string
) {
  return {
    schema,
    model: resolveModel('research', researchModel),
    instructions,
    errorStrategy: 'warn' as const,
  };
}

/** Structuring instructions for one research group's transcript. */
function researchStructuringInstructions(fieldNames: readonly string[]): string {
  return [
    'You turn a research transcript (tool calls, tool results and the researcher’s final answer) into JSON that matches the response schema.',
    `Fields: ${fieldNames.join(', ')}. Use exactly these names in \`field\`, one finding per field, and no other names.`,
    'Report a value only when a tool result in the transcript supports it. Put the url of that page in `evidence.url` and copy the supporting text word for word from the tool result into `evidence.quote`.',
    'When the transcript does not support a value for a field, report the field with value null, confidence 0 and empty evidence rather than guess. Never invent a url, a quote or a value, and never fill a field with a default.',
    '`notes`: one or two sentences on what was searched and what was not found.',
  ].join('\n');
}

/** Structuring instructions for the identify call's transcript. */
function identifyStructuringInstructions(emailDomain: string): string {
  return [
    'You turn a research transcript (tool calls, tool results and the researcher’s final answer) into JSON that matches the response schema: the company behind a contact email.',
    `The email domain is ${emailDomain || '(none)'}.`,
    'Take every value from the tool results or the final answer; never guess. Use an empty string for a value the transcript does not give, and confidence 0 when it does not identify the company.',
  ].join('\n');
}

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

/**
 * Drain an agent's stream: forward every Firecrawl progress event to the step
 * writer tagged with `groupId`, and collect into `readUrls` every url a
 * successful tool result shows was read (see read-urls.ts). Progress events
 * are written before a fetch, so they never count as a read.
 */
async function forwardStream(
  fullStream: AsyncIterable<unknown>,
  writer: { write(data: unknown): Promise<void> },
  groupId: string,
  readUrls: Set<string>
): Promise<void> {
  for await (const chunk of fullStream) {
    const type = (chunk as { type?: string }).type;

    if (type === 'tool-output') {
      for (const event of progressEventsIn(chunk)) {
        await writer.write({ ...event, groupId } satisfies FirecrawlProgressEvent);
      }
    }

    if (type === 'tool-result') {
      const payload = (chunk as { payload?: { toolName?: string; result?: unknown; isError?: boolean } }).payload;
      for (const url of payload ? readUrlsFromToolResult(payload) : []) {
        if (readUrls.has(url)) continue;
        readUrls.add(url);
        await writer.write({ type: 'page-read', groupId, url } satisfies PageReadEvent);
      }
    }
  }
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
  execute: async ({ inputData, mastra, setState, writer, abortSignal }) => {
    const agent = mastra.getAgent('identify');
    const email = inputData.email.trim();

    const stream = await agent.stream(
      [
        `Email to identify: ${email}`,
        `Email domain: ${email.split('@')[1] ?? '(none)'}`,
        '',
        'Find the company this email belongs to.',
      ].join('\n'),
      {
        requestContext: requestContextFor(inputData.models?.research),
        maxSteps: IDENTIFY_MAX_STEPS,
        prepareStep: answerOnLastStep(IDENTIFY_MAX_STEPS),
        abortSignal,
        structuredOutput: structuredOutputOptions(
          CompanyContext,
          inputData.models?.research,
          identifyStructuringInstructions(email.split('@')[1] ?? '')
        ),
      }
    );

    await forwardStream(stream.fullStream, writer, 'identify', new Set());

    const company = CompanyContext.safeParse(await stream.object);
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
    description:
      'Research one group of fields and keep only findings backed by pages the tools read (and, with EVIDENCE_CHECK on, by quotes that support the value).',
    inputSchema: ResearchItem,
    outputSchema: GroupResultSchema,
    stateSchema: WorkflowState,
    execute: async ({ inputData: item, state, mastra, writer, abortSignal, tracingContext }) => {
      const { group } = item;
      // State is where the identify step left the company; the item carries a
      // copy so a step run on its own (Studio, a test) still has one.
      const company = state.company ?? item.companyContext;
      const agent = mastra.getAgent('research');

      await writer.write({
        type: 'group-start',
        groupId: group.id,
        label: group.label,
        strategy: group.strategy,
        fieldNames: group.fieldNames,
      } satisfies GroupStartEvent);

      const stream = await agent.stream(renderGroupPrompt(item, company), {
        requestContext: requestContextFor(item.researchModel, group.strategy),
        maxSteps: MAX_STEPS[group.strategy],
        prepareStep: answerOnLastStep(MAX_STEPS[group.strategy]),
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
        structuredOutput: structuredOutputOptions(
          PhaseOutput,
          item.researchModel,
          researchStructuringInstructions(group.fieldNames)
        ),
      });

      const readUrls = new Set<string>();
      await forwardStream(stream.fullStream, writer, group.id, readUrls);

      // Undefined when the structuring call failed (see structuredOutputOptions).
      const parsed = PhaseOutput.safeParse(await stream.object);
      const output = parsed.success ? parsed.data : NO_FINDINGS;
      const structuredOutputFailed = !parsed.success;

      const read = checkFindings(output.findings, group.fieldNames, readUrls);

      // Optional second check: does each kept quote support its value? Off
      // unless EVIDENCE_CHECK turns it on; see evidence-support.ts.
      const evidenceCheck = evidenceCheckConfig();
      const supported = evidenceCheck.enabled
        ? await checkEvidenceSupport(read.findings, {
            classifier: mastra.getClassifier('evidenceSupport'),
            threshold: evidenceCheck.threshold,
            fieldDescriptions: new Map(item.fields.map((field) => [field.name, field.description])),
            groupId: group.id,
            abortSignal,
            tracingContext,
          })
        : { findings: read.findings, notes: [] };
      const checked = { findings: supported.findings, notes: [...read.notes, ...supported.notes] };

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

      await writer.write({
        type: 'group-complete',
        groupId: group.id,
        label: group.label,
        fieldNames: group.fieldNames,
        found: checked.findings.filter((finding) => finding.value !== null && finding.evidence.length > 0).length,
        structuredOutputFailed,
      } satisfies GroupCompleteEvent);

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
