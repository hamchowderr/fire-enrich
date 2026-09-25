import { type NextRequest, NextResponse } from 'next/server';

import { notFound } from '@/lib/api/profiles-http';
import { deletePlan, getPlan } from '@/lib/plans';

/**
 * Next.js 15 hands dynamic route params as a promise, so every handler awaits
 * them. Typed once here rather than repeated on both signatures.
 */
type RouteContext = { params: Promise<{ id: string }> };

/** `GET /api/plans/:id` → the saved plan row, `plan` included whole. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const plan = await getPlan(id);

  return plan ? NextResponse.json({ plan }) : notFound(id, 'plan');
}

/**
 * `DELETE /api/plans/:id`
 *
 * Deletes the plan row only. Runs recorded in Dolt that followed the plan
 * keep their rows and their `plan_id`; nothing here touches them.
 *
 * There is no PUT: a plan is the planner's output for one goal, and editing it
 * in place would leave runs that already followed it pointing at a plan they
 * did not run. Generate a new one instead.
 */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const deleted = await deletePlan(id);

  return deleted ? NextResponse.json({ id, deleted: true }) : notFound(id, 'plan');
}
