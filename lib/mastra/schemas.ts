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
