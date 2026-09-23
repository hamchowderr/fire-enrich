import { RequestContext } from '@mastra/core/request-context';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { badRequest, notFound, parseJsonBody, requireDolt } from '@/lib/api/profiles-http';
import { mastra } from '@/lib/mastra';
import {
  normalizePlanNames,
  resolvePlannerProfile,
  setPlannerProfile,
  type PlannerRequestContext,
} from '@/lib/mastra/agents/planner';
import { putPlan } from '@/lib/mastra/plan-cache';
import { planIssues, ResearchPlan, type ResearchPlanType } from '@/lib/mastra/schemas';
import { getPlan, savePlan } from '@/lib/plans';
import {
  FieldGenerationResponse,
  type FieldGenerationResponseType,
} from '@/lib/types/field-generation';

/** Named in the 503 when a body needs Dolt and it is not configured. */
const FEATURE = 'Saved plans';

/**
 * `POST /api/generate-fields` → a research plan.
 *
 * Three body shapes:
 *
 * - `{ prompt }`, what the current UI sends. The prompt is the goal, and the
 *   profile is the default one (see `resolvePlannerProfile`).
 * - `{ profileId, goal, audience }`, where `profileId` and `audience` are
 *   optional. With `save: true` the plan is also saved under `profileId`
 *   (which is then required) and the response carries `data.planId`.
 * - `{ planId }`: a saved plan, returned as it was saved. The planner is not
 *   called; `prompt`, `goal` and `save` are ignored.
 *
 * The response keeps the shape the UI already reads, `{ success, data: {
 * fields, interpretation } }` with `fields` as in `lib/types/field-generation`,
 * and adds `data.plan` with the full plan and, when the plan is a saved one,
 * `data.planId`. The plan is also cached by its field names (with its id) so
 * the enrichment run that follows can find it and record which plan it ran.
 */
const bodySchema = z.object({
  prompt: z.string().trim().min(1).optional(),
  goal: z.string().trim().min(1).optional(),
  profileId: z.string().trim().min(1).optional(),
  audience: z.string().trim().min(1).optional(),
  planId: z.string().trim().min(1).optional(),
  save: z.boolean().optional(),
});

/**
 * Drop the planning-only properties to get the field shape the UI consumes.
 * Parsed through the UI's own schema so a drift between the two shapes fails
 * here, in the route, rather than as a silently broken field list.
 */
function toFieldGeneration(plan: ResearchPlanType): FieldGenerationResponseType {
  return FieldGenerationResponse.parse({
    fields: plan.fields.map(({ displayName, description, type, examples }) => ({
      displayName,
      description,
      type,
      examples,
    })),
    interpretation: plan.interpretation,
  });
}

/** The one response envelope, for a generated plan and a saved one alike. */
function planResponse(plan: ResearchPlanType, planId?: string): NextResponse {
  return NextResponse.json({
    success: true,
    data: { ...toFieldGeneration(plan), plan, ...(planId ? { planId } : {}) },
  });
}

export async function POST(request: NextRequest) {
  const body = await parseJsonBody(request);
  if (body.error) return body.error;

  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return badRequest(parsed.error, 'request');

  const { planId, save, profileId, audience } = parsed.data;
  const goal = parsed.data.goal ?? parsed.data.prompt;

  try {
    if (planId) {
      const unconfigured = requireDolt(FEATURE);
      if (unconfigured) return unconfigured;

      const saved = await getPlan(planId);
      if (!saved) return notFound(planId, 'plan');

      putPlan(saved.plan, { planId: saved.id });
      return planResponse(saved.plan, saved.id);
    }

    if (!goal) return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });

    // Saving needs a profile to save under, and the default profile is
    // resolved by name inside the planner, not as an id this route could use.
    if (save && !profileId) {
      return NextResponse.json({ error: 'profileId is required to save a plan' }, { status: 400 });
    }

    // A caller naming a profile gets a clear answer when it cannot be used,
    // rather than a plan made silently for the generic one.
    if (profileId) {
      const unconfigured = requireDolt(FEATURE);
      if (unconfigured) return unconfigured;
    }

    const profile = await resolvePlannerProfile(profileId);
    if (profileId && profile.source === 'generic') return notFound(profileId);

    const requestContext = new RequestContext<PlannerRequestContext>();
    requestContext.set('goal', goal);
    if (profileId) requestContext.set('profileId', profileId);
    if (audience) requestContext.set('audience', audience);
    setPlannerProfile(requestContext, profile);

    const result = await mastra.getAgent('planner').generate(goal, {
      requestContext,
      structuredOutput: { schema: ResearchPlan },
    });

    const plan = normalizePlanNames(result.object);

    // Reported rather than rejected: a plan with one group or a query missing
    // its placeholder is weaker, not unusable, and the fields are still good.
    const issues = planIssues(plan);
    if (issues.length > 0) console.warn('Planner returned an imperfect plan:', issues);

    // Saved after normalising, so the stored field names are the ones the UI
    // derives and a later lookup by field set finds this plan.
    const savedId =
      save && profileId ? (await savePlan({ profileId, goal, audience, plan })).id : undefined;

    putPlan(plan, { planId: savedId });

    return planResponse(plan, savedId);
  } catch (error) {
    console.error('Field generation error:', error);
    return NextResponse.json({ error: 'Failed to generate fields' }, { status: 500 });
  }
}
