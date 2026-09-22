/**
 * HTTP glue shared by the two profiles route files.
 *
 * Both route modules need the same three answers — "Dolt is not configured",
 * "that body is not JSON", "that body is the wrong shape" — and a client should
 * not be able to tell which handler it hit from the error it gets back. Keeping
 * them here means one wording and one status code per condition instead of two
 * copies that drift.
 *
 * Route files hold only the handlers Next.js looks for by convention, so this
 * lives outside `app/`.
 */
import { type NextRequest, NextResponse } from 'next/server';
import type { ZodError } from 'zod';

import { doltConfigured } from '@/lib/dolt';

/**
 * 503 when Dolt is not configured, `null` when it is.
 *
 * 503 and not 500: nothing has failed, the feature is not switched on in this
 * environment. The message names the variables to set so the answer is
 * actionable without reading the source.
 */
export function requireDolt(): NextResponse | null {
  if (doltConfigured()) return null;

  return NextResponse.json(
    {
      error:
        'Profiles need a Dolt database. Set DOLT_HOST and DOLT_DATABASE (see .env.example) and restart.',
    },
    { status: 503 }
  );
}

/**
 * Read a JSON request body.
 *
 * Returns the parsed value or a ready 400 response, so a handler branches once
 * instead of wrapping every read in its own try/catch.
 */
export async function parseJsonBody(
  request: NextRequest
): Promise<{ value: unknown; error: null } | { value: null; error: NextResponse }> {
  try {
    return { value: await request.json(), error: null };
  } catch {
    return {
      value: null,
      error: NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 }),
    };
  }
}

/**
 * 400 carrying the validation issues.
 *
 * The issues ship as-is (`path`, `message`, `code` per issue) rather than being
 * flattened to one sentence: a client sending five fields needs to know which
 * one was wrong, and the path is what lets a form highlight it.
 */
export function badRequest(error: ZodError): NextResponse {
  return NextResponse.json(
    { error: 'Invalid profile', issues: error.issues },
    { status: 400 }
  );
}

/** 404 for an id that matches no profile. */
export function notFound(id: string): NextResponse {
  return NextResponse.json({ error: `No profile with id ${id}` }, { status: 404 });
}
