/**
 * Schemas for what the planner agent produces: a research plan.
 *
 * A plan is the planner's answer to "what should we find out about each
 * company, and how?". It names the fields to fill, then groups them into
 * research groups that share their searches, so one set of queries answers
 * several fields at once.
 *
 * Every property is required, with "none" expressed as an empty array or an
 * empty string rather than an omitted key. Providers' structured-output modes
 * handle required properties far more reliably than optional ones, and the
 * consumers of a plan never need to tell "missing" apart from "empty".
 */
import { z } from 'zod';

/**
 * The placeholders a query may contain, substituted per row when the query
 * runs. Nothing else in a query is templated: the planner writes the rest.
 */
export const QUERY_PLACEHOLDERS = ['{company}', '{domain}'] as const;

/** How a field is researched. */
const FieldStrategy = z
  .enum(['search', 'agent', 'browser'])
  .describe(
    'search: web search plus page reads answer it. agent: needs synthesis across several sources. browser: a page must be driven (clicks, forms, pagination) to see the answer.'
  );

const PlannedField = z.object({
  name: z
    .string()
    .min(1)
    .describe('Variable name in snake_case, derived from displayName, unique within the plan'),
  displayName: z.string().min(1).describe('Human-readable name for the field'),
  description: z.string().min(1).describe('What data this field should contain'),
  type: z.enum(['string', 'number', 'boolean', 'array']).describe('The data type of the field'),
  examples: z.array(z.string()).describe('Example values for this field, empty array if none'),
  strategy: FieldStrategy,
});

const ResearchGroup = z.object({
  id: z.string().min(1).describe('Short kebab-case id, unique within the plan'),
  label: z.string().min(1).describe('Human-readable name for the group'),
  fieldNames: z
    .array(z.string())
    .min(1)
    .describe('The `name` of every field this group researches'),
  strategy: FieldStrategy,
  queries: z
    .array(z.string())
    .min(1)
    .describe('Search queries; each uses {company} and/or {domain} as placeholders'),
  preferredSources: z
    .array(z.string())
    .describe('Kinds of sources or domains to prefer for this group'),
  instructions: z
    .string()
    .describe('What counts as good evidence for this group and what to reject'),
});

export const ResearchPlan = z.object({
  fields: z.array(PlannedField).min(1),
  groups: z.array(ResearchGroup).min(1),
  interpretation: z
    .string()
    .describe('Brief explanation of how the goal was read and what the plan covers'),
});

export type ResearchPlanType = z.infer<typeof ResearchPlan>;
export type ResearchGroupType = ResearchPlanType['groups'][number];

/**
 * Who a contact's email belongs to, as the identify agent resolved it.
 *
 * Every research group reads this before it searches: it is what the
 * `{company}` and `{domain}` placeholders in a plan's queries are filled from.
 * `confidence` is the agent's own 0–1 estimate; 0 means it found nothing and
 * the rest of the object only restates the email domain.
 */
export const CompanyContext = z.object({
  companyName: z.string().describe('The company name as the company writes it, empty string if not found'),
  domain: z.string().describe('The registrable domain of the company website, e.g. example.com'),
  website: z.string().describe('The company homepage url, empty string if not found'),
  description: z
    .string()
    .describe('One or two sentences on what the company does, taken from its own pages; empty string if not found'),
  confidence: z.number().describe('0 to 1: how sure you are that this is the company behind the email'),
});

export type CompanyContextType = z.infer<typeof CompanyContext>;

/** A value a finding may carry. `null` is an honest "not found". */
const FindingValue = z
  .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
  .describe('The value in the field type; null when no page you read supports a value');

const Evidence = z.object({
  url: z.string().describe('A url you actually read with a tool during this task'),
  quote: z.string().describe('The exact text on that page that supports the value, copied verbatim'),
  confidence: z.number().describe('0 to 1: how strongly this quote supports the value'),
});

const Finding = z.object({
  field: z.string().describe('The `name` of the field this finding fills'),
  value: FindingValue,
  confidence: z.number().describe('0 to 1: overall confidence in the value; 0 when value is null'),
  evidence: z.array(Evidence).describe('Every page quote supporting the value; empty when value is null'),
  sourcesAgree: z.boolean().describe('True when every piece of evidence supports the same value'),
});

/**
 * What one research group returns: a finding per field it was asked for.
 *
 * Static on purpose. The field names differ per plan, so a schema keyed by
 * field would have to be built per call; a list of `{ field, value }` findings
 * validates the same way for every plan, and the caller checks the field names
 * against the group instead.
 */
export const PhaseOutput = z.object({
  findings: z.array(Finding),
  notes: z.string().describe('What was searched, what was not found and why; empty string if nothing to add'),
});

export type PhaseOutputType = z.infer<typeof PhaseOutput>;
export type FindingType = z.infer<typeof Finding>;

/**
 * A field the enrichment run was asked to fill.
 *
 * The shape the UI sends (`lib/types` `EnrichmentField`): the field-generation
 * definition plus the variable `name` it derived from `displayName`. `examples`
 * and `required` are optional because the UI drops or adds them.
 */
export const EnrichFieldDefinition = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'array']),
  examples: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});

export type EnrichFieldDefinitionType = z.infer<typeof EnrichFieldDefinition>;

/**
 * Per-run model overrides, as gateway ids (`provider/model`).
 *
 * The same hook `resolveModel(role, override)` exposes, carried as data so a
 * run (or a Studio call) can try another model without an env var.
 */
const ModelOverrides = z.object({
  research: z.string().min(1).optional(),
});

export const EnrichRowInput = z.object({
  sessionId: z.string().min(1).describe('The enrichment session this row belongs to'),
  rowIndex: z.number().int().min(0),
  email: z.string().min(3).describe('The contact email the row is keyed on'),
  plan: ResearchPlan.optional().describe(
    'The research plan. Omit it to resolve one from the fields: a cached plan that covers them, else a new one from the planner.'
  ),
  fields: z.array(EnrichFieldDefinition).min(1),
  models: ModelOverrides.optional(),
});

/** @public What a caller of `enrichRow` passes; the SSE adapter builds it per row. */
export type EnrichRowInputType = z.infer<typeof EnrichRowInput>;

/** `EnrichmentResult` from `lib/types`, as a schema, so the workflow output is validated. */
const EnrichmentValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const EnrichmentResultSchema = z.object({
  field: z.string(),
  value: EnrichmentValue,
  confidence: z.number(),
  source: z.string().optional(),
  sourceContext: z.array(z.object({ url: z.string(), snippet: z.string() })).optional(),
  sourceCount: z.number().optional(),
  corroboration: z
    .object({
      evidence: z.array(
        z.object({
          value: EnrichmentValue,
          source_url: z.string(),
          exact_text: z.string(),
          confidence: z.number(),
        })
      ),
      sources_agree: z.boolean(),
    })
    .optional(),
});

export const EnrichRowOutput = z.object({
  rowIndex: z.number(),
  email: z.string(),
  /** `input`: the run was given the plan; `cache` / `planner`: it was resolved from the fields. */
  planSource: z.enum(['input', 'cache', 'planner']),
  company: CompanyContext,
  /** Only fields with a value backed by evidence; see `unknown` for the rest. */
  enrichments: z.record(z.string(), EnrichmentResultSchema),
  unknown: z.array(z.object({ field: z.string(), reason: z.string() })),
  groups: z.array(
    z.object({
      groupId: z.string(),
      strategy: z.enum(['search', 'agent', 'browser']),
      fieldNames: z.array(z.string()),
      found: z.number(),
      structuredOutputFailed: z.boolean(),
      notes: z.string(),
    })
  ),
});

/** @public What `enrichRow` returns; the SSE adapter reads it. */
export type EnrichRowOutputType = z.infer<typeof EnrichRowOutput>;

/**
 * Whether a query uses at least one of {@link QUERY_PLACEHOLDERS}.
 *
 * @public Part of this module's API. {@link planIssues} and tests use it today;
 * the enrichment step will, to skip queries it cannot address to one row.
 */
export function hasPlaceholder(query: string): boolean {
  return QUERY_PLACEHOLDERS.some((placeholder) => query.includes(placeholder));
}

/**
 * Structural problems a schema cannot express, as human-readable strings.
 * Empty when the plan is coherent.
 *
 * Kept outside the zod schema on purpose: the schema is also sent to the model
 * as JSON Schema, and cross-references between arrays have no JSON Schema form.
 * A refinement would be dropped from what the model sees and then fail the
 * whole generation on a detail the caller can report instead.
 *
 * Checks: at least two groups; every group references known fields; every
 * field belongs to a group; every query uses a placeholder; ids and names are
 * unique.
 */
export function planIssues(plan: ResearchPlanType): string[] {
  const issues: string[] = [];
  const names = new Set<string>();

  for (const field of plan.fields) {
    if (names.has(field.name)) issues.push(`Duplicate field name "${field.name}"`);
    names.add(field.name);
  }

  if (plan.groups.length < 2) issues.push('A plan needs at least two research groups');

  const grouped = new Set<string>();
  const ids = new Set<string>();

  for (const group of plan.groups) {
    if (ids.has(group.id)) issues.push(`Duplicate group id "${group.id}"`);
    ids.add(group.id);

    for (const name of group.fieldNames) {
      if (!names.has(name)) issues.push(`Group "${group.id}" references unknown field "${name}"`);
      grouped.add(name);
    }

    for (const query of group.queries) {
      if (!hasPlaceholder(query)) {
        issues.push(`Group "${group.id}" query has no placeholder: "${query}"`);
      }
    }
  }

  for (const name of names) {
    if (!grouped.has(name)) issues.push(`Field "${name}" is not in any research group`);
  }

  return issues;
}
