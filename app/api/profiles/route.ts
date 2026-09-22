import { type NextRequest, NextResponse } from 'next/server';

import {
  createProfile,
  createProfileSchema,
  listProfiles,
  ProfileNameTakenError,
} from '@/lib/profiles';
import { badRequest, conflict, parseJsonBody, requireDolt } from '@/lib/api/profiles-http';

/** `GET /api/profiles` → every profile, newest first. */
export async function GET() {
  const unconfigured = requireDolt();
  if (unconfigured) return unconfigured;

  return NextResponse.json({ profiles: await listProfiles() });
}

/** `POST /api/profiles` → create one profile. */
export async function POST(request: NextRequest) {
  const unconfigured = requireDolt();
  if (unconfigured) return unconfigured;

  const body = await parseJsonBody(request);
  if (body.error) return body.error;

  const parsed = createProfileSchema.safeParse(body.value);
  if (!parsed.success) return badRequest(parsed.error);

  try {
    return NextResponse.json({ profile: await createProfile(parsed.data) }, { status: 201 });
  } catch (error) {
    if (error instanceof ProfileNameTakenError) return conflict(error);
    throw error;
  }
}
