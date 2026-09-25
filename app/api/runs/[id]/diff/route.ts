import { type NextRequest, NextResponse } from 'next/server';

import { notFound } from '@/lib/api/profiles-http';
import { requireRunHistory } from '@/lib/api/runs-http';
import {
  diffRuns,
  getRun,
  previousRunFor,
  RunNotCommittedError,
  RunNotFoundError,
  RunsNotComparableError,
} from '@/lib/runs';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * `GET /api/runs/:id/diff[?against=<runId>]`
 *
 * The values that changed between run `:id` and an earlier run of the same
 * list: `against` when given, else the run before it ({@link previousRunFor}).
 * `predecessor` is the id of the run compared against, or null when `:id` is
 * the first run of its list; `changes` is then empty. An empty `changes` with
 * a `predecessor` means nothing changed.
 *
 * 400 when `against` is `:id` itself or a run of a different list, 404 for an
 * unknown run on either side, 409 for a run row with no commit (only after a
 * hand edit), 501 "requires Dolt" ({@link requireRunHistory}) when Dolt,
 * which is optional, is not configured.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const unconfigured = requireRunHistory('Run diffs');
  if (unconfigured) return unconfigured;

  const { id } = await context.params;
  const against = request.nextUrl.searchParams.get('against')?.trim() || null;

  try {
    const fromId = against ?? (await previousRunFor(id))?.id ?? null;
    if (!fromId) {
      const to = await getRun(id);
      if (!to) return notFound(id, 'run');
      return NextResponse.json({ from: null, to, predecessor: null, changes: [] });
    }

    const { from, to, changes } = await diffRuns(fromId, id);
    return NextResponse.json({ from, to, predecessor: from.id, changes });
  } catch (error) {
    if (error instanceof RunNotFoundError) return notFound(error.runId, 'run');
    if (error instanceof RunsNotComparableError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof RunNotCommittedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
