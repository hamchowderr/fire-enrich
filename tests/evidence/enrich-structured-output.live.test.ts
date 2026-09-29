/**
 * The enrichRow workflow against the real gateway and Firecrawl, to measure
 * structured-output failures per research group.
 *
 * Skipped unless `ENRICH_LIVE=1`, so the normal suite and CI never call a paid
 * service. `tests/setup.ts` hands the real keys to this file as
 * `ENRICH_LIVE_GATEWAY_KEY` and `ENRICH_LIVE_FIRECRAWL_KEY` and stubs the
 * global ones as usual. Every model call goes through `resolveModel`, which
 * this file replaces with the real gateway model wrapped to count calls; every
 * Firecrawl call goes through the SDK class, which this file wraps the same
 * way. A call past either cap throws instead of being made, and no further
 * row starts.
 *
 *   ENRICH_LIVE=1 ENRICH_LIVE_RUN=probe ENRICH_LIVE_MAX_MODEL_CALLS=20 \
 *   ENRICH_LIVE_MAX_FIRECRAWL_CALLS=15 infisical run --path=/fire-enrich --silent -- \
 *     npx vitest run tests/evidence/enrich-structured-output.live.test.ts --disableConsoleIntercept
 *
 * Runs (`ENRICH_LIVE_RUN`):
 * - `probe`: one row and one search group whose loop is cut to 3 steps, so the
 *   last step goes out with `toolChoice: 'none'` after tool calls. It records
 *   what each model request carried and whether the provider accepted it.
 * - `full`: 8 rows, 4 fields, a plan from the planner (generic profile).
 *
 * Both caps are required and must be positive whole numbers.
 * `ENRICH_LIVE_OUT` is the JSON file the results are written to.
 * The temp libSQL file, `EVIDENCE_CHECK=0` and `TRACING=0` come from
 * `tests/setup.ts`; the workflow needs no Dolt.
 */
import { writeFileSync } from 'node:fs';

import { createGateway } from '@ai-sdk/gateway';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const live = process.env.ENRICH_LIVE === '1';

const counters = vi.hoisted(() => ({
  model: 0,
  firecrawl: 0,
  maxModel: 0,
  maxFirecrawl: 0,
  capHit: '' as string,
  requests: [] as Array<{
    role: string;
    modelId: string;
    tools: number;
    toolChoice: string | undefined;
    toolHistory: boolean;
    responseFormat: string | undefined;
    finishReason?: string;
    error?: string;
  }>,
}));

vi.mock('firecrawl', async (importOriginal) => {
  const real = await importOriginal<typeof import('firecrawl')>();
  const count = (method: string) => {
    if (counters.firecrawl + 1 > counters.maxFirecrawl) {
      counters.capHit ||= `Firecrawl cap of ${counters.maxFirecrawl} reached (${method})`;
      throw new Error(counters.capHit);
    }
    counters.firecrawl += 1;
  };
  // Every SDK method the tools call, counted before it runs.
  class CountingFirecrawl extends real.Firecrawl {}
  const proto = CountingFirecrawl.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const base = real.Firecrawl.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['search', 'scrape', 'map', 'startAgent', 'getAgentStatus', 'cancelAgent']) {
    proto[method] = function (this: unknown, ...args: unknown[]) {
      count(method);
      return base[method].apply(this, args);
    };
  }
  return { ...real, Firecrawl: CountingFirecrawl };
});

vi.mock('@/lib/mastra/models', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/mastra/models')>();
  if (process.env.ENRICH_LIVE !== '1') return original;

  type StreamOptions = {
    tools?: unknown[];
    toolChoice?: { type: string };
    responseFormat?: { type: string };
    prompt: Array<{ role: string; content: unknown }>;
  };

  const hasToolHistory = (prompt: StreamOptions['prompt']) =>
    prompt.some(
      (message) =>
        message.role === 'tool' ||
        (Array.isArray(message.content) &&
          (message.content as Array<{ type?: string }>).some((part) => part.type === 'tool-call'))
    );

  return {
    ...original,
    resolveModel: (role: Parameters<typeof original.resolveModel>[0], override?: string) => {
      const gateway = createGateway({ apiKey: process.env.ENRICH_LIVE_GATEWAY_KEY });
      const inner = gateway(override ?? original.DEFAULT_MODEL_IDS[role]);
      const before = (options: StreamOptions) => {
        if (counters.model + 1 > counters.maxModel) {
          counters.capHit ||= `model cap of ${counters.maxModel} reached`;
          throw new Error(counters.capHit);
        }
        counters.model += 1;
        const request = {
          role,
          modelId: inner.modelId,
          tools: options.tools?.length ?? 0,
          toolChoice: options.toolChoice?.type,
          toolHistory: hasToolHistory(options.prompt),
          responseFormat: options.responseFormat?.type,
        } as (typeof counters.requests)[number];
        counters.requests.push(request);
        return request;
      };
      return new Proxy(inner, {
        get(target, key, receiver) {
          if (key === 'doStream') {
            return async (options: Parameters<typeof inner.doStream>[0]) => {
              const request = before(options as unknown as StreamOptions);
              try {
                const result = await target.doStream(options);
                const watched = result.stream.pipeThrough(
                  new TransformStream({
                    transform(chunk, controller) {
                      const part = chunk as { type: string; finishReason?: unknown; error?: unknown };
                      if (part.type === 'finish') request.finishReason = JSON.stringify(part.finishReason);
                      if (part.type === 'error') request.error = String((part.error as Error)?.message ?? part.error).slice(0, 500);
                      controller.enqueue(chunk);
                    },
                  })
                );
                return { ...result, stream: watched };
              } catch (error) {
                request.error = String((error as Error)?.message ?? error).slice(0, 500);
                throw error;
              }
            };
          }
          if (key === 'doGenerate') {
            return async (options: Parameters<typeof inner.doGenerate>[0]) => {
              const request = before(options as unknown as StreamOptions);
              try {
                const result = await target.doGenerate(options);
                request.finishReason = JSON.stringify(result.finishReason);
                return result;
              } catch (error) {
                request.error = String((error as Error)?.message ?? error).slice(0, 500);
                throw error;
              }
            };
          }
          return Reflect.get(target, key, receiver);
        },
      });
    },
  };
});

import { mastra } from '@/lib/mastra';
import { resolvePlan } from '@/lib/mastra/plan-fallback';
import type { EnrichFieldDefinitionType, EnrichRowOutputType, ResearchPlanType } from '@/lib/mastra/schemas';

/** A cap: required, a positive whole number. Anything else throws. */
function parseCap(name: string): number {
  const raw = process.env[name];
  const value = Number(raw?.trim());
  if (!raw || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const FIELDS: EnrichFieldDefinitionType[] = [
  { name: 'companyName', displayName: 'Company Name', description: 'The name of the company', type: 'string' },
  {
    name: 'companyDescription',
    displayName: 'Company Description',
    description: 'A brief description of what the company does',
    type: 'string',
  },
  { name: 'industry', displayName: 'Industry', description: 'The primary industry the company operates in', type: 'string' },
  {
    name: 'businessModel',
    displayName: 'Business Model',
    description:
      'How the company makes money, e.g. subscription software, usage-based API, marketplace, advertising, hardware sales',
    type: 'string',
  },
];

const ROWS = [
  'hello@firecrawl.dev',
  'support@supabase.com',
  'hi@mintlify.com',
  'support@langchain.dev',
  'hello@convex.dev',
  'support@hex.tech',
  'hello@vanta.com',
  'support@brex.com',
];

/** The probe's plan: one search group that is asked to keep searching. */
const PROBE_PLAN: ResearchPlanType = {
  fields: [
    {
      name: 'industry',
      displayName: 'Industry',
      description: 'The primary industry the company operates in',
      type: 'string',
      examples: [],
      strategy: 'search',
    },
  ],
  groups: [
    {
      id: 'industry',
      label: 'Industry',
      fieldNames: ['industry'],
      strategy: 'search',
      queries: ['{company} industry', '{company} about', '{company} category'],
      preferredSources: ['the company website', 'business directories'],
      instructions:
        'Run each suggested search as a separate firecrawl-search call, one per turn, before you answer, even when the first result already answers.',
    },
  ],
  interpretation: 'Step-limit probe.',
};

/** Steps the probe's research loop may take; the production limit is 10. */
const PROBE_MAX_STEPS = 3;

/** Only the path and message of each failed check: no values. */
function validationLines(message: string): string[] {
  return message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
}

describe.skipIf(!live)('enrichRow structured output (live gateway and Firecrawl)', () => {
  const warnings: string[] = [];
  const lastStepHits: string[] = [];
  let researchStream: ReturnType<typeof vi.spyOn>;
  let identifyStream: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    counters.maxModel = parseCap('ENRICH_LIVE_MAX_MODEL_CALLS');
    counters.maxFirecrawl = parseCap('ENRICH_LIVE_MAX_FIRECRAWL_CALLS');
    expect(process.env.ENRICH_LIVE_GATEWAY_KEY, 'ENRICH_LIVE=1 needs AI_GATEWAY_API_KEY').toBeTruthy();
    expect(process.env.ENRICH_LIVE_FIRECRAWL_KEY, 'ENRICH_LIVE=1 needs FIRECRAWL_API_KEY').toBeTruthy();
    process.env.FIRECRAWL_API_KEY = process.env.ENRICH_LIVE_FIRECRAWL_KEY;

    for (const method of ['warn', 'error', 'info'] as const) {
      const original = console[method].bind(console);
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        const text = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' ');
        if (/Structured output|StructuredOutputProcessor|Structuring failed/i.test(text)) warnings.push(text);
        original(...args);
      });
    }

    // Note every call whose prepareStep took the last-step branch (no tools).
    // In the probe, also cut the research loop to PROBE_MAX_STEPS and shift the
    // step number so the workflow's own prepareStep fires on the last of them.
    const probe = process.env.ENRICH_LIVE_RUN === 'probe';
    const wrap = (name: string) => {
      const agent = mastra.getAgent(name as 'research');
      const original = agent.stream.bind(agent);
      return vi.spyOn(agent, 'stream').mockImplementation(((prompt: unknown, options: Record<string, unknown>) => {
        const label = /## Research group: (.*)/.exec(String(prompt))?.[1] ?? name;
        const email = /Contact email: (.*)|Email to identify: (.*)/.exec(String(prompt));
        const key = `${email?.[1] ?? email?.[2] ?? ''} / ${label}`;
        const prepareStep = options.prepareStep as ((args: { stepNumber: number }) => unknown) | undefined;
        const maxSteps = options.maxSteps as number;
        const shift = probe && name === 'research' ? maxSteps - PROBE_MAX_STEPS : 0;
        return original(prompt as never, {
          ...options,
          maxSteps: maxSteps - shift,
          prepareStep: (args: { stepNumber: number }) => {
            const result = prepareStep?.({ ...args, stepNumber: args.stepNumber + shift });
            if (result && (result as { toolChoice?: string }).toolChoice === 'none') lastStepHits.push(key);
            return result;
          },
        } as never);
      }) as never);
    };
    researchStream = wrap('research');
    identifyStream = wrap('identify');
  });

  afterAll(() => {
    researchStream?.mockRestore();
    identifyStream?.mockRestore();
    vi.restoreAllMocks();
  });

  async function enrich(email: string, rowIndex: number, plan: ResearchPlanType) {
    const run = await mastra.getWorkflow('enrichRow').createRun();
    const result = await run.start({
      inputData: { sessionId: 'enrich-live', rowIndex, email, plan, fields: FIELDS.filter((f) => plan.fields.some((p) => p.name === f.name)) },
    });
    if (result.status !== 'success') {
      const error = (result as { error?: { message?: string } }).error?.message ?? result.status;
      return { email, status: result.status, error: String(error).slice(0, 500) };
    }
    return { email, status: 'success', output: result.result as EnrichRowOutputType };
  }

  it('runs and records', { timeout: 1_800_000 }, async () => {
    const runName = process.env.ENRICH_LIVE_RUN;
    expect(['probe', 'full'], 'ENRICH_LIVE_RUN must be probe or full').toContain(runName);
    const started = Date.now();

    let plan: ResearchPlanType;
    let planSource = 'probe';
    let emails: string[];
    if (runName === 'probe') {
      plan = PROBE_PLAN;
      emails = [ROWS[0]];
    } else {
      const resolved = await resolvePlan(FIELDS, { planner: mastra.getAgent('planner') });
      plan = resolved.plan;
      planSource = resolved.source;
      emails = ROWS;
      const strategies = new Set(plan.groups.map((group) => group.strategy));
      // Browser sessions are not counted by this harness, and the hosted agent
      // is billed per job; stop before any row if the plan asks for either.
      expect([...strategies], 'the plan must use search groups only').toEqual(['search']);
    }

    const rows = [];
    for (const [index, email] of emails.entries()) {
      if (counters.capHit) break;
      rows.push(await enrich(email, index, plan));
    }

    const groups = rows.flatMap((row) =>
      (row.output?.groups ?? []).map((group) => ({
        email: row.email,
        groupId: group.groupId,
        strategy: group.strategy,
        fieldNames: group.fieldNames,
        found: group.found,
        structuredOutputFailed: group.structuredOutputFailed,
      }))
    );
    const fieldsAsked = rows.filter((row) => row.output).length * plan.fields.length;
    const fieldsFilled = rows.reduce((sum, row) => sum + Object.keys(row.output?.enrichments ?? {}).length, 0);
    const industryRows = rows.filter((row) => row.output);
    const industryFilled = industryRows.filter((row) => row.output?.enrichments.industry).length;

    const report = {
      run: runName,
      date: new Date().toISOString().slice(0, 10),
      researchModel: 'anthropic/claude-sonnet-4.5',
      planSource,
      plan: plan.groups.map((group) => ({ id: group.id, strategy: group.strategy, fieldNames: group.fieldNames })),
      wallSeconds: Math.round((Date.now() - started) / 1000),
      caps: { model: counters.maxModel, firecrawl: counters.maxFirecrawl },
      calls: { model: counters.model, firecrawl: counters.firecrawl },
      capHit: counters.capHit || null,
      rows: rows.map((row) => ({
        email: row.email,
        status: row.status,
        error: 'error' in row ? row.error : undefined,
        companyIdentified: Boolean(row.output?.company.companyName),
        filled: Object.keys(row.output?.enrichments ?? {}),
      })),
      groups,
      groupsWithStructuredOutputFailure: groups.filter((group) => group.structuredOutputFailed).length,
      fieldsFilled: `${fieldsFilled}/${fieldsAsked}`,
      industryFilled: `${industryFilled}/${industryRows.length}`,
      callsThatHitTheLastStep: lastStepHits,
      validationFailures: warnings.map(validationLines).filter((lines) => lines.length > 0),
      structuringErrors: warnings
        .filter((text) => /StructuredOutputProcessor|Structuring failed/.test(text))
        .map((text) => text.slice(0, 300)),
      modelRequests: counters.requests,
    };

    const out = process.env.ENRICH_LIVE_OUT;
    if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, modelRequests: undefined }, null, 2));

    expect(rows.length).toBeGreaterThan(0);
  });
});
