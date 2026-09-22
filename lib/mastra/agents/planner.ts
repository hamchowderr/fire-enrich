import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import { z } from 'zod';

import { doltConfigured } from '@/lib/dolt';
import { getProfile, listProfiles, resolveProfileModels, type Profile } from '@/lib/profiles';
import { generateVariableName } from '@/lib/utils/field-utils';

import { resolveModel } from '../models';
import { QUERY_PLACEHOLDERS, type ResearchPlanType } from '../schemas';

/**
 * Planner agent: turns a business profile and a goal into a research plan.
 *
 * It has no tools. Everything it needs arrives through the request context
 * (`profileId`, `goal`, `audience`) and is rendered into its instructions; its
 * output is a `ResearchPlan` requested by the caller with `structuredOutput`.
 * Nothing about the research is fixed in code: the fields, the grouping, the
 * queries and the sources all come from the model reading the profile and the
 * goal. The only template the code imposes is the pair of placeholders in
 * {@link QUERY_PLACEHOLDERS}, which the enrichment step substitutes per row.
 */

/** Values a caller may put on the request context for the planner. */
const plannerRequestContextSchema = z.object({
  profileId: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  audience: z.string().min(1).optional(),
});

export type PlannerRequestContext = z.infer<typeof plannerRequestContextSchema>;

/**
 * The profile a plan was made for, with where it came from.
 *
 * `generic` means no stored profile was available and the plan was made for
 * {@link GENERIC_PROFILE}; the model is told to say so in its interpretation.
 */
export type PlannerProfile = {
  profile: Pick<
    Profile,
    'name' | 'business_summary' | 'offer' | 'audiences' | 'default_field_hints' | 'models'
  >;
  source: 'requested' | 'default' | 'first' | 'generic';
};

/**
 * Minimal stand-in used when there is no profile to read: Dolt is not
 * configured, or it holds no profiles yet. Deliberately vague so it never
 * steers a plan towards one kind of business.
 */
const GENERIC_PROFILE: PlannerProfile['profile'] = {
  name: 'Unspecified business',
  business_summary: 'No business profile is on file.',
  offer: 'Unknown.',
  audiences: [],
  default_field_hints: [],
  models: {},
};

/**
 * Request-context key under which the resolved profile is kept for the rest of
 * the request. Instructions and model are resolved separately by Mastra, and
 * both need the profile; stashing the lookup means one read per request, and
 * lets a caller that already loaded the profile hand it in.
 */
const PROFILE_KEY = 'planner.profile';

/**
 * Find the profile to plan for.
 *
 * - A requested id is read, and a missing row falls back to the generic
 *   profile (the route checks existence first and answers 404 instead).
 * - With no id: `DEFAULT_PROFILE_ID` when set, else the newest profile.
 * - With Dolt unconfigured or empty: the generic profile.
 *
 * A failure to reach Dolt on the no-id path also falls back to generic: planning
 * worked before profiles existed, and a database outage should degrade the plan
 * rather than take field generation down with it. A requested id does not get
 * that grace, because the caller asked for something specific.
 */
export async function resolvePlannerProfile(profileId?: string): Promise<PlannerProfile> {
  if (!doltConfigured()) return { profile: GENERIC_PROFILE, source: 'generic' };

  if (profileId) {
    const requested = await getProfile(profileId);
    return requested
      ? { profile: requested, source: 'requested' }
      : { profile: GENERIC_PROFILE, source: 'generic' };
  }

  try {
    const defaultId = process.env.DEFAULT_PROFILE_ID;
    if (defaultId) {
      const configured = await getProfile(defaultId);
      if (configured) return { profile: configured, source: 'default' };
    }

    const [newest] = await listProfiles();
    if (newest) return { profile: newest, source: 'first' };
  } catch (error) {
    console.warn('Planner could not read a profile; planning with a generic one.', error);
  }

  return { profile: GENERIC_PROFILE, source: 'generic' };
}

/** Put an already-resolved profile on the context so the agent does not read it again. */
export function setPlannerProfile(
  requestContext: RequestContext<PlannerRequestContext>,
  resolved: PlannerProfile
): void {
  requestContext.setRaw(PROFILE_KEY, Promise.resolve(resolved));
}

function plannerProfile(
  requestContext: RequestContext<PlannerRequestContext>
): Promise<PlannerProfile> {
  const cached = requestContext.getRaw(PROFILE_KEY) as Promise<PlannerProfile> | undefined;
  if (cached) return cached;

  const pending = resolvePlannerProfile(requestContext.get('profileId'));
  requestContext.setRaw(PROFILE_KEY, pending);
  return pending;
}

function bulletList(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : empty;
}

/** Render the instructions for one request. */
function renderPlannerInstructions(
  { profile, source }: PlannerProfile,
  context: PlannerRequestContext
): string {
  const [company, domain] = QUERY_PLACEHOLDERS;

  const profileNote =
    source === 'generic'
      ? 'No stored business profile was available, so this plan uses a generic profile. Say so in `interpretation`, and plan from the goal alone.'
      : 'Plan for the business below. Everything you choose should make sense for what it sells and who it sells to.';

  return [
    'You are a research planner for a company-enrichment tool.',
    'The user has a list of companies (each with a name and a website domain) and a goal. You decide which facts to find about every company and how to find them. You do not do the research; you write the plan that researchers will follow for each row.',
    '',
    '## Business profile',
    profileNote,
    `Name: ${profile.name}`,
    `Summary: ${profile.business_summary}`,
    `Offer: ${profile.offer}`,
    'Audiences:',
    bulletList(profile.audiences, '- (none recorded)'),
    'Field hints (facts this business usually wants; use the ones that serve the goal, drop the rest):',
    bulletList(profile.default_field_hints, '- (none recorded)'),
    '',
    '## Request',
    `Goal: ${context.goal ?? 'the goal is the user message.'}`,
    `Audience: ${context.audience ?? 'not specified; infer it from the goal and the profile audiences.'}`,
    '',
    '## What to produce',
    'Return a research plan:',
    '- `fields`: the facts to find for each company. Choose them from the goal and the profile, and only include facts that help the goal. Give each a snake_case `name` derived from its `displayName`, a precise `description`, a `type` (string, number, boolean or array), `examples` of realistic values, and a `strategy`.',
    '- `groups`: at least two research groups. A group is a set of fields that the same searches can answer. Every field belongs to exactly one group; `fieldNames` lists the `name` of each.',
    `- \`queries\`: search queries written for this goal and these fields. Use the placeholder ${company} for the company name and ${domain} for its website domain, exactly as written, braces included; every query uses at least one of them. Do not use any other placeholder. Write two to four queries per group, each aimed at a different angle.`,
    '- `preferredSources`: the kinds of sources or specific sites most likely to hold trustworthy evidence for the group (for example the company website section, a registry, a review site, a job board).',
    '- `instructions`: what counts as good evidence for the group, how recent it must be, and what to reject.',
    '- `strategy` (per field and per group): `search` for ordinary facts that a search plus reading the result pages answers; `agent` when the answer has to be synthesised across several sources; `browser` only when a page must be driven (clicks, forms, pagination, a logged-out app view) to see the answer.',
    '- `interpretation`: one or two sentences on how you read the goal and what the plan covers.',
    '',
    'Do not add fields just because they are common in enrichment (funding, executives, headcount and the like). Include them only when this goal needs them.',
  ].join('\n');
}

export const plannerAgent = new Agent({
  id: 'planner',
  name: 'Planner',
  description:
    'Turns a business profile and a goal into a research plan: fields, research groups, queries and sources.',
  requestContextSchema: plannerRequestContextSchema,
  instructions: async ({ requestContext }) =>
    renderPlannerInstructions(await plannerProfile(requestContext), {
      profileId: requestContext.get('profileId'),
      goal: requestContext.get('goal'),
      audience: requestContext.get('audience'),
    }),
  // The profile may name its own planner model; `resolveProfileModels` fills in
  // the code default for any role it does not override. Never read from env.
  model: async ({ requestContext }) => {
    const { profile } = await plannerProfile(requestContext);
    return resolveModel('planner', resolveProfileModels(profile).planner);
  },
});

/**
 * Make field names match what the UI will derive from them.
 *
 * The UI discards `name` and regenerates it from `displayName` with
 * {@link generateVariableName} before sending fields to enrichment. Renaming
 * here the same way means the fields that come back later carry the names in
 * this plan, so a cached plan can be found again by its field set. Group
 * references are rewritten to follow.
 */
export function normalizePlanNames(plan: ResearchPlanType): ResearchPlanType {
  const taken: string[] = [];
  const renamed = new Map<string, string>();

  const fields = plan.fields.map((field) => {
    const name = generateVariableName(field.displayName, taken);
    taken.push(name);
    if (!renamed.has(field.name)) renamed.set(field.name, name);
    return { ...field, name };
  });

  const groups = plan.groups.map((group) => ({
    ...group,
    fieldNames: group.fieldNames.map((name) => renamed.get(name) ?? name),
  }));

  return { ...plan, fields, groups };
}
