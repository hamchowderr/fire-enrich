/**
 * Business profiles — the first-class record of who a business is, what it
 * sells, and who it sells to.
 *
 * A profile is the planner's input. It is data in Dolt rather than prompt text
 * pasted into a request, so it can be edited without a deploy, versioned with
 * the rest of the data, and read back exactly as it was when a run used it.
 *
 * Field names here are the database column names (`business_summary`,
 * `default_field_hints`), carried unchanged through SQL, this module, and the
 * HTTP body. One spelling per field across the whole stack removes a mapping
 * layer that would otherwise need its own tests and would be the obvious place
 * for a silent typo to lose a field.
 */
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { commit, query, select, toJsonColumn } from '@/lib/dolt';
import { DEFAULT_MODEL_IDS, type ModelRole } from '@/lib/mastra/models';

/** Columns holding JSON, parsed on read and stringified on write. */
const JSON_COLUMNS = ['audiences', 'default_field_hints', 'crm_defaults', 'models'] as const;

/** The model roles a profile may override, taken from the defaults it falls back to. */
const MODEL_ROLES = Object.keys(DEFAULT_MODEL_IDS) as ModelRole[];

/** Identity written to `dolt_log` for changes made through the profiles API. */
const COMMIT_AUTHOR = 'Fire Enrich <fire-enrich@localhost>';

/**
 * Per-role model overrides.
 *
 * Every role is optional and the object is closed to unknown keys: a profile
 * records only where it disagrees with {@link DEFAULT_MODEL_IDS}, and a
 * misspelled role is a 400 rather than an override that silently never applies.
 * The value is any non-empty string because it is a gateway model id
 * (`provider/model`) whose valid set lives at the gateway, not here.
 */
const modelsSchema = z
  .object(
    Object.fromEntries(
      MODEL_ROLES.map((role) => [role, z.string().min(1).optional()])
    ) as Record<ModelRole, z.ZodOptional<z.ZodString>>
  )
  .strict();

/** What a client may send to create a profile. */
export const createProfileSchema = z.object({
  name: z.string().trim().min(1).max(255),
  business_summary: z.string().trim().min(1),
  offer: z.string().trim().min(1),
  // Default to empty rather than required: a profile is useful before its
  // audiences and hints are filled in, and an operator refines them over time.
  audiences: z.array(z.string().trim().min(1)).default([]),
  default_field_hints: z.array(z.string().trim().min(1)).default([]),
  crm_defaults: z.record(z.unknown()).default({}),
  models: modelsSchema.default({}),
});

/**
 * What a client may send to update a profile.
 *
 * Every field optional, and at least one required: a `PUT` with an empty body
 * would otherwise be accepted, make no change, and still write a Dolt commit
 * claiming an edit happened.
 */
export const updateProfileSchema = createProfileSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Provide at least one field to update',
  });

/**
 * A stored profile as it is read back and returned to clients.
 *
 * Not exported: it exists to derive {@link Profile}. Rows come from the database
 * rather than from a client, so nothing parses through it — re-validating our
 * own writes on every read would cost a pass per row to catch a bug the writes
 * above already prevent.
 */
const profileSchema = createProfileSchema.extend({
  id: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
});

export type CreateProfileInput = z.input<typeof createProfileSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type Profile = z.infer<typeof profileSchema>;

/** Columns selected for a profile, in a fixed order so reads are identical. */
const PROFILE_COLUMNS =
  'id, name, business_summary, offer, audiences, default_field_hints, crm_defaults, models, created_at, updated_at';

/** Column order used by the insert; kept next to the values that fill it. */
const INSERT_COLUMNS =
  'id, name, business_summary, offer, audiences, default_field_hints, crm_defaults, models';

const SELECT_PROFILE_BY_ID = `SELECT ${PROFILE_COLUMNS} FROM profiles WHERE id = ?`;
const SELECT_PROFILES = `SELECT ${PROFILE_COLUMNS} FROM profiles ORDER BY created_at DESC, id DESC`;
const INSERT_PROFILE = `INSERT INTO profiles (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const DELETE_PROFILE = 'DELETE FROM profiles WHERE id = ?';

/**
 * Build the `UPDATE` for a patch: only the fields present are assigned.
 *
 * `updated_at` is left to the column's `ON UPDATE CURRENT_TIMESTAMP` so the
 * database owns the clock.
 */
function buildUpdate(
  id: string,
  patch: UpdateProfileInput
): { sql: string; params: unknown[] } {
  const assignments: string[] = [];
  const params: unknown[] = [];

  for (const [column, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    params.push(
      (JSON_COLUMNS as readonly string[]).includes(column) ? toJsonColumn(value) : value
    );
  }

  params.push(id);

  return { sql: `UPDATE profiles SET ${assignments.join(', ')} WHERE id = ?`, params };
}

/**
 * A write collided with the `UNIQUE` index on `profiles.name`.
 *
 * The database is the thing that enforces uniqueness, so this translates its
 * error rather than trying to prevent it: a read-then-write check here would
 * still lose the race between two concurrent creates of the same name, and
 * would cost an extra round trip on every write to catch a case the index
 * already catches for free.
 *
 * Carries the offending name so the route can name the field the client has to
 * change, instead of a bare "conflict".
 */
export class ProfileNameTakenError extends Error {
  // Not `name`: that would shadow `Error.prototype.name` and corrupt how the
  // error prints in a stack trace.
  readonly profileName: string;

  constructor(profileName: string) {
    super(`A profile named "${profileName}" already exists`);
    this.name = 'ProfileNameTakenError';
    this.profileName = profileName;
  }
}

/**
 * Whether the driver is reporting a unique-index collision.
 *
 * `profiles.name` carries the only unique index on the table, so an
 * `ER_DUP_ENTRY` from a profile write is always that index. Matching on the
 * driver's `code` rather than the numeric `errno` (1062) keeps this readable,
 * and both are stable across MySQL and Dolt.
 */
function isDuplicateName(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ER_DUP_ENTRY';
}

/** Read one profile. `null` when no row has that id. */
export async function getProfile(id: string): Promise<Profile | null> {
  const [row] = await select<Profile>(SELECT_PROFILE_BY_ID, [id], JSON_COLUMNS);
  return row ?? null;
}

/** Read every profile, newest first. */
export async function listProfiles(): Promise<Profile[]> {
  return select<Profile>(SELECT_PROFILES, [], JSON_COLUMNS);
}

/**
 * Create a profile and commit it.
 *
 * The id is generated here rather than by the database so the commit message can
 * name the row it created, and so the caller has the id without a second read.
 *
 * @throws {ProfileNameTakenError} when the name is already in use.
 */
export async function createProfile(input: CreateProfileInput): Promise<Profile> {
  const profile = createProfileSchema.parse(input);
  const id = nanoid();

  try {
    await query(INSERT_PROFILE, [
      id,
      profile.name,
      profile.business_summary,
      profile.offer,
      toJsonColumn(profile.audiences),
      toJsonColumn(profile.default_field_hints),
      toJsonColumn(profile.crm_defaults),
      toJsonColumn(profile.models),
    ]);
  } catch (error) {
    if (isDuplicateName(error)) throw new ProfileNameTakenError(profile.name);
    throw error;
  }

  // Reached only once the insert succeeded, so a rejected write never leaves a
  // commit behind claiming it happened.
  await commit(`Create profile ${id} (${profile.name})`, COMMIT_AUTHOR);

  // Read back rather than returning the input: `created_at` and `updated_at`
  // come from the database, and this proves the row is actually readable.
  const created = await getProfile(id);
  if (!created) throw new Error(`Profile ${id} was inserted but could not be read back`);

  return created;
}

/**
 * Apply a patch to a profile and commit it. `null` when no row has that id.
 *
 * The existence check is a read before the write so a missing row is a clean 404
 * rather than an `UPDATE` that reports zero affected rows — which is also what a
 * patch that changes nothing reports, and the two mean different things.
 *
 * @throws {ProfileNameTakenError} when the patch renames onto a name in use.
 */
export async function updateProfile(
  id: string,
  patch: UpdateProfileInput
): Promise<Profile | null> {
  const existing = await getProfile(id);
  if (!existing) return null;

  const validated = updateProfileSchema.parse(patch);
  const { sql, params } = buildUpdate(id, validated);

  try {
    await query(sql, params);
  } catch (error) {
    // A patch that leaves `name` alone cannot collide, but report whatever name
    // the row would have ended up with rather than guessing.
    if (isDuplicateName(error)) {
      throw new ProfileNameTakenError(validated.name ?? existing.name);
    }
    throw error;
  }

  await commit(`Update profile ${id} (${existing.name})`, COMMIT_AUTHOR);

  return getProfile(id);
}

/** Delete a profile and commit it. `false` when no row had that id. */
export async function deleteProfile(id: string): Promise<boolean> {
  const existing = await getProfile(id);
  if (!existing) return false;

  await query(DELETE_PROFILE, [id]);
  await commit(`Delete profile ${id} (${existing.name})`, COMMIT_AUTHOR);

  return true;
}

/**
 * The model id to use for each role when running this profile.
 *
 * A profile only stores the roles it overrides, so this is where a partial
 * override becomes a complete answer. Callers get every role filled in and never
 * have to know that `models` may be missing keys — or missing entirely, which is
 * what a caller holding a profile read before this column existed would see.
 *
 * The planner agent calls it to pick its model from the profile it was given.
 */
export function resolveProfileModels(
  profile: Pick<Profile, 'models'> | null | undefined
): Record<ModelRole, string> {
  const overrides = profile?.models ?? {};
  const resolved = { ...DEFAULT_MODEL_IDS } as Record<ModelRole, string>;

  for (const role of MODEL_ROLES) {
    const override = overrides[role];
    if (typeof override === 'string' && override.length > 0) resolved[role] = override;
  }

  return resolved;
}
