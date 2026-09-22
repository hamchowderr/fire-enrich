import { type NextRequest, NextResponse } from 'next/server';

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
 */
export async function PUT(request: NextRequest, context: RouteContext) {
  const unconfigured = requireDolt();
  if (unconfigured) return unconfigured;

  const { id } = await context.params;

  const body = await parseJsonBody(request);
  if (body.error) return body.error;

  const parsed = updateProfileSchema.safeParse(body.value);
  if (!parsed.success) return badRequest(parsed.error);

  try {
    const profile = await updateProfile(id, parsed.data);
    return profile ? NextResponse.json({ profile }) : notFound(id);
  } catch (error) {
    if (error instanceof ProfileNameTakenError) return conflict(error);
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
