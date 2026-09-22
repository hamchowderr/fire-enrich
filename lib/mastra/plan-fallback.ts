/**
 * Find or make the research plan for a set of fields.
 *
 * Enrichment is keyed on the fields a run was given, and a run normally
 * follows field generation, which cached the plan it made. When it does not —
 * the cache expired, another process served field generation, or the user
 * typed the fields by hand — there is still no default plan to fall back on:
 * the queries have to be written for these fields. So the fallback asks the
 * planner, with the field definitions as the goal, and caches what it returns
 * for the next row of the same run.
 *
 * The planner's plan is then reconciled with the requested fields, because
 * those are the fields the table has columns for: planned fields are matched
 * by name and then by display name, fields the planner added are dropped, and
 * a requested field it left out joins the first group so it is still
 * researched. The requested definitions replace the planner's wording; the
 * planner's strategy for each field is kept.
 */
import type { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';

import { generateVariableName } from '@/lib/utils/field-utils';

import { normalizePlanNames, type PlannerRequestContext } from './agents/planner';
import { getPlanForFields, putPlan, restrictPlan } from './plan-cache';
import {
  planIssues,
  ResearchPlan,
  type EnrichFieldDefinitionType,
  type ResearchPlanType,
} from './schemas';

/**
 * The goal handed to the planner when no cached plan covers the fields.
 *
 * @public Exported so tests can assert what the planner is asked; only
 * {@link resolvePlan} calls it in production.
 */
export function fallbackGoal(fields: readonly EnrichFieldDefinitionType[]): string {
  return [
    'Collect these fields for a company. Plan research for exactly these fields, keeping each display name as written:',
    ...fields.map(
      (field) =>
        `- ${field.displayName} (${field.type}): ${field.description || 'no description given'}` +
        (field.examples?.length ? ` Examples: ${field.examples.join(', ')}.` : '')
    ),
  ].join('\n');
}

function nameKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Make a planner plan answer exactly the requested fields (see the module comment).
 *
 * @public Exported so tests can check the reconciliation without a model call;
 * only {@link resolvePlan} calls it in production.
 */
export function reconcilePlan(
  planned: ResearchPlanType,
  fields: readonly EnrichFieldDefinitionType[]
): ResearchPlanType {
  const plan = normalizePlanNames(planned);
  const byName = new Map(plan.fields.map((field) => [field.name, field]));
  const byDisplay = new Map(plan.fields.map((field) => [nameKey(field.displayName), field]));

  // Planned name -> requested name, for every planned field that answers one.
  const rename = new Map<string, string>();
  const reconciledFields: ResearchPlanType['fields'] = [];
  const missing: string[] = [];

  for (const field of fields) {
    const match =
      byName.get(field.name) ??
      byDisplay.get(nameKey(field.displayName)) ??
      byName.get(generateVariableName(field.displayName, []));

    if (match && !rename.has(match.name)) rename.set(match.name, field.name);
    else missing.push(field.name);

    reconciledFields.push({
      name: field.name,
      displayName: field.displayName,
      description: field.description || field.displayName,
      type: field.type,
      examples: field.examples ?? [],
      strategy: match?.strategy ?? plan.groups[0]?.strategy ?? 'search',
    });
  }

  const groups = plan.groups.map((group) => ({
    ...group,
    fieldNames: group.fieldNames.flatMap((name) => (rename.has(name) ? [rename.get(name) as string] : [])),
  }));

  if (missing.length > 0 && groups.length > 0) {
    groups[0] = { ...groups[0], fieldNames: [...groups[0].fieldNames, ...missing] };
  }

  return restrictPlan(
    { ...plan, fields: reconciledFields, groups },
    fields.map((field) => field.name)
  );
}

type PlanSource = 'cache' | 'planner';

/**
 * The plan for `fields`: from the cache when one covers them (exactly or as a
 * subset), otherwise from the planner, reconciled and cached.
 *
 * `planner` is the registered planner agent (`mastra.getAgent('planner')`),
 * passed in rather than imported so this module does not import the Mastra
 * instance that registers the workflow calling it.
 *
 * Throws when the planner fails or returns a plan with no group that covers a
 * requested field: an enrichment run cannot proceed without queries, and a
 * made-up plan would be exactly the hard-coded research this replaces.
 */
export async function resolvePlan(
  fields: readonly EnrichFieldDefinitionType[],
  { planner, abortSignal }: { planner: Pick<Agent, 'generate'>; abortSignal?: AbortSignal }
): Promise<{ plan: ResearchPlanType; source: PlanSource }> {
  const names = fields.map((field) => field.name);

  const cached = getPlanForFields(names);
  if (cached) return { plan: cached, source: 'cache' };

  const goal = fallbackGoal(fields);
  const requestContext = new RequestContext<PlannerRequestContext>();
  requestContext.set('goal', goal);

  const result = await planner.generate(goal, {
    requestContext,
    structuredOutput: { schema: ResearchPlan },
    abortSignal,
  });

  const plan = reconcilePlan(ResearchPlan.parse(result.object), fields);
  if (plan.groups.length === 0) {
    throw new Error('The planner returned no research group for the requested fields.');
  }

  const issues = planIssues(plan);
  if (issues.length > 0) console.warn('Fallback plan is imperfect:', issues);

  putPlan(plan);
  return { plan, source: 'planner' };
}
