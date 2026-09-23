/**
 * HTTP glue shared by the Dolt-backed route files: profiles, saved plans, and
 * field generation when it reads or saves a plan.
 *
 * Every one of them needs the same three answers — "Dolt is not configured",
 * "that body is not JSON", "that body is the wrong shape" — and a client should
 * not be able to tell which handler it hit from the error it gets back. Keeping
 * them here means one wording and one status code per condition instead of
 * copies that drift. The helpers name the resource in their message
 * (`Invalid profile`, `No plan with id …`) through a parameter that defaults to
 * the profile wording, so the profiles routes read as they always did.
 *
 * Route files hold only the handlers Next.js looks for by convention, so this
 * lives outside `app/`.
 */
import { type NextRequest, NextResponse } from 'next/server';
import type { ZodError } from 'zod';

import { doltConfigured } from '@/lib/dolt';
import type { ProfileNameTakenError } from '@/lib/profiles';

/**
 * 503 when Dolt is not configured, `null` when it is.
 *
 * 503 and not 500: nothing has failed, the feature is not switched on in this
 * environment. The message names the feature that needs it (a plural noun:
 * "Profiles", "Saved plans") and the variables to set, so the answer is
 * actionable without reading the source.
 */
export function requireDolt(feature = 'Profiles'): NextResponse | null {
  if (doltConfigured()) return null;

  return NextResponse.json(
    {
      error: `${feature} need a Dolt database. Set DOLT_HOST and DOLT_DATABASE (see .env.example) and restart.`,
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
 * one was wrong, and the path is what lets a form highlight it. `subject` is
 * what was invalid, as the message names it: "profile", "plan", "query".
 */
export function badRequest(error: ZodError, subject = 'profile'): NextResponse {
  return NextResponse.json(
    { error: `Invalid ${subject}`, issues: error.issues },
    { status: 400 }
  );
}

/** 404 for an id that matches no row of `resource` ("profile", "plan"). */
export function notFound(id: string, resource = 'profile'): NextResponse {
  return NextResponse.json({ error: `No ${resource} with id ${id}` }, { status: 404 });
}

/**
 * 409 when a write would reuse a profile name.
 *
 * 409 rather than 400: the body is well-formed and the client could not have
 * known it would collide — only the database can say, and only at write time.
 * `field` names `name` so a form can highlight the one input to change, the
 * same affordance the 400 path gets from an issue's `path`.
 */
export function conflict(error: ProfileNameTakenError): NextResponse {
  return NextResponse.json(
    { error: error.message, field: 'name', value: error.profileName },
    { status: 409 }
  );
}
