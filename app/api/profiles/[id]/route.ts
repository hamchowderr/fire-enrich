import { type NextRequest, NextResponse } from 'next/server';
import { z, ZodError } from 'zod';

import {
  badRequest,
  conflict,
  notFound,
  parseJsonBody,
  requireDolt,
} from '@/lib/api/profiles-http';
import {
  deleteProfile,
  getProfile,
  ProfileNameTakenError,
  updateProfile,
  updateProfileSchema,
} from '@/lib/profiles';

/**
 * Next.js 15 hands dynamic route params as a promise, so every handler awaits
 * them. Typed once here rather than repeated on three signatures.
 */
type RouteContext = { params: Promise<{ id: string }> };

/**
 * The query `PUT` accepts. `merge` is spelled out as `true` or `false` so a
 * typo such as `?merge=ture` is a 400 instead of a silent replace.
 */
const putQuerySchema = z.object({ merge: z.enum(['true', 'false']).optional() });

/** `GET /api/profiles/:id` */
export async function GET(_request: NextRequest, context: RouteContext) {
  const unconfigured = requireDolt();
  if (unconfigured) return unconfigured;

  const { id } = await context.params;
  const profile = await getProfile(id);

  return profile ? NextResponse.json({ profile }) : notFound(id);
}

/**
 * `PUT /api/profiles/:id`
 *
 * A partial update, despite the verb: every field is optional and only the ones
 * sent are written. PUT rather than PATCH because this is the one write path a
 * client has for an existing profile, and splitting replace-vs-merge semantics
 * across two verbs would mean two code paths for no gain.
 *
 * By default each JSON column sent replaces the stored value whole:
 * `{ models: { research } }` leaves a profile with only a research override.
 * `?merge=true` merges the object columns into what is stored instead:
 *
 * - `models` merges per role key, so the planner and chat overrides survive.
 * - `crm_defaults` merges recursively through nested plain objects, so sibling
 *   keys survive at every level. An array or scalar value replaces the one at
 *   its key.
 * - `audiences` and `default_field_hints` are replaced as without the option.
 *
 * The merge cannot remove a key; send the column without `merge` to replace it.
 * The merged result is validated with the same schema as the body, and a
 * result that fails is a 400 with nothing written or committed. The option is
 * a query parameter rather than a body field so the body stays exactly the
 * profile fields `updateProfileSchema` describes.
 */
export async function PUT(request: NextRequest, context: RouteContext) {
  const unconfigured = requireDolt();
  if (unconfigured) return unconfigured;

  const { id } = await context.params;

  const query = putQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return badRequest(query.error, 'query');

  const body = await parseJsonBody(request);
  if (body.error) return body.error;

  const parsed = updateProfileSchema.safeParse(body.value);
  if (!parsed.success) return badRequest(parsed.error);

  try {
    const profile = await updateProfile(id, parsed.data, { merge: query.data.merge === 'true' });
    return profile ? NextResponse.json({ profile }) : notFound(id);
  } catch (error) {
    if (error instanceof ProfileNameTakenError) return conflict(error);
    // Only the merged result can fail here: the body passed the same schema above.
    if (error instanceof ZodError) return badRequest(error);
    throw error;
  }
}

/** `DELETE /api/profiles/:id` */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const unconfigured = requireDolt();
  if (unconfigured) return unconfigured;

  const { id } = await context.params;
  const deleted = await deleteProfile(id);

  return deleted ? NextResponse.json({ id, deleted: true }) : notFound(id);
}
