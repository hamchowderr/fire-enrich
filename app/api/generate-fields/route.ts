import { RequestContext } from '@mastra/core/request-context';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { notFound, parseJsonBody, requireDolt } from '@/lib/api/profiles-http';
import { mastra } from '@/lib/mastra';
import {
  normalizePlanNames,
  resolvePlannerProfile,
  setPlannerProfile,
  type PlannerRequestContext,
} from '@/lib/mastra/agents/planner';
import { putPlan } from '@/lib/mastra/plan-cache';
import { planIssues, ResearchPlan, type ResearchPlanType } from '@/lib/mastra/schemas';
import {
  FieldGenerationResponse,
  type FieldGenerationResponseType,
} from '@/lib/types/field-generation';

/**
 * `POST /api/generate-fields` → a research plan from the planner agent.
 *
 * Two body shapes:
 *
 * - `{ prompt }`, what the current UI sends. The prompt is the goal, and the
 *   profile is the default one (see `resolvePlannerProfile`).
 * - `{ profileId, goal, audience }`, where `profileId` and `audience` are
 *   optional.
 *
 * The response keeps the shape the UI already reads, `{ success, data: {
 * fields, interpretation } }` with `fields` as in `lib/types/field-generation`,
 * and adds `data.plan` with the full plan. The plan is also cached by its field
 * names so the enrichment run that follows can find it.
 */
const bodySchema = z.object({
  prompt: z.string().trim().min(1).optional(),
  goal: z.string().trim().min(1).optional(),
  profileId: z.string().trim().min(1).optional(),
  audience: z.string().trim().min(1).optional(),
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

export async function POST(request: NextRequest) {
  const body = await parseJsonBody(request);
  if (body.error) return body.error;

  const parsed = bodySchema.safeParse(body.value);
  const goal = parsed.success ? (parsed.data.goal ?? parsed.data.prompt) : undefined;

  if (!parsed.success || !goal) {
    return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
  }

  const { profileId, audience } = parsed.data;

  try {
    // A caller naming a profile gets a clear answer when it cannot be used,
    // rather than a plan made silently for the generic one.
    if (profileId) {
      const unconfigured = requireDolt();
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

    putPlan(plan);

    return NextResponse.json({
      success: true,
      data: { ...toFieldGeneration(plan), plan },
    });
  } catch (error) {
    console.error('Field generation error:', error);
    return NextResponse.json({ error: 'Failed to generate fields' }, { status: 500 });
  }
}
