import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { badRequest, notFound, parseJsonBody } from '@/lib/api/profiles-http';
import { listPlans, PlanProfileMissingError, savePlan, savePlanSchema } from '@/lib/plans';

/**
 * The list is always per profile: a plan is meaningless without the profile it
 * was planned for, and "every plan of every profile" is not a view anyone
 * asked for.
 */
const listQuerySchema = z.object({ profileId: z.string().trim().min(1) });

/** `GET /api/plans?profileId=` → every plan saved for that profile, newest first. */
export async function GET(request: NextRequest) {
  const parsed = listQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return badRequest(parsed.error, 'query');

  return NextResponse.json({ plans: await listPlans(parsed.data.profileId) });
}

/**
 * `POST /api/plans` → save one plan under a profile.
 *
 * Body: `{ profileId, goal, audience?, plan }`, with `plan` a full
 * `ResearchPlan`. 404 names the profile when it does not exist; the database
 * is what says so, at write time.
 */
export async function POST(request: NextRequest) {
  const body = await parseJsonBody(request);
  if (body.error) return body.error;

  const parsed = savePlanSchema.safeParse(body.value);
  if (!parsed.success) return badRequest(parsed.error, 'plan');

  try {
    return NextResponse.json({ plan: await savePlan(parsed.data) }, { status: 201 });
  } catch (error) {
    if (error instanceof PlanProfileMissingError) return notFound(error.profileId, 'profile');
    throw error;
  }
}
