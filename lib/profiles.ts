/**
 * Business profiles — the first-class record of who a business is, what it
 * sells, and who it sells to.
 *
 * A profile is the planner's input. It is data in the app's libSQL database
 * (`lib/app-db.ts`: Turso, or the local file fallback) rather than prompt text
 * pasted into a request, so it can be edited without a deploy. Every
 * deployment has that database, so profiles work with or without Dolt.
 *
 * Field names here are the database column names (`business_summary`,
 * `default_field_hints`), carried unchanged through SQL, this module, and the
 * HTTP body. One spelling per field across the whole stack removes a mapping
 * layer that would otherwise need its own tests and would be the obvious place
 * for a silent typo to lose a field.
 */
import type { InValue } from '@libsql/client';
import { nanoid } from 'nanoid';
import { z } from 'zod';

import {
  appDb,
  isBusy,
  isUniqueViolation,
  parseJsonColumns,
  type Row,
  selectRows,
  toJsonColumn,
  withWriteTransaction,
} from '@/lib/app-db';
import { DEFAULT_MODEL_IDS, type ModelRole } from '@/lib/mastra/models';

/** Columns holding JSON, parsed on read and stringified on write. */
const JSON_COLUMNS = ['audiences', 'default_field_hints', 'crm_defaults', 'models'] as const;

/** The model roles a profile may override, taken from the defaults it falls back to. */
const MODEL_ROLES = Object.keys(DEFAULT_MODEL_IDS) as ModelRole[];

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
 * would otherwise be accepted, make no change, and still move `updated_at`
 * as if an edit happened.
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
/** A profile's plans go with it, as `ON DELETE CASCADE` declares. */
const DELETE_PROFILE_PLANS = 'DELETE FROM research_plans WHERE profile_id = ?';

/** A row as libSQL returns it, with the JSON columns parsed. */
function toProfile(row: Row): Profile {
  return parseJsonColumns(row, JSON_COLUMNS) as Profile;
}

/**
 * Build the `UPDATE` for a patch: only the fields present are assigned, then
 * `updated_at`. SQLite has no `ON UPDATE CURRENT_TIMESTAMP`, so the statement
 * sets it, still from the database's clock rather than the app's.
 */
function buildUpdate(id: string, patch: UpdateProfileInput): { sql: string; args: InValue[] } {
  const assignments: string[] = [];
  const args: InValue[] = [];

  for (const [column, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    args.push(
      (JSON_COLUMNS as readonly string[]).includes(column)
        ? toJsonColumn(value)
        : (value as InValue)
    );
  }

  assignments.push('updated_at = CURRENT_TIMESTAMP');
  args.push(id);

  return { sql: `UPDATE profiles SET ${assignments.join(', ')} WHERE id = ?`, args };
}

/** How {@link updateProfile} applies a patch. */
export interface UpdateProfileOptions {
  /**
   * Merge the object columns into the stored values instead of replacing them.
   *
   * `models` merges per role key and `crm_defaults` merges recursively through
   * plain objects. Every other field, the arrays included, is replaced as
   * without the option: there is no way to address one element of a list of
   * strings, so a merge of `audiences` could only append, and an editor that
   * removes an audience would have no way to say so.
   */
  merge?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge `patch` into `base` through nested plain objects; any other value in
 * `patch` (an array, a scalar, `null`) replaces what `base` held at that key.
 *
 * Returns a new object and leaves both inputs alone. Keys are defined rather
 * than assigned so a `__proto__` key from parsed JSON stays an ordinary own
 * property instead of reaching the prototype setter.
 */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    const current = Object.hasOwn(merged, key) ? merged[key] : undefined;
    Object.defineProperty(merged, key, {
      value: isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return merged;
}

/**
 * The patch with its object columns merged into the stored profile.
 *
 * `models` is flat (role to model id), so a key-level spread is the whole
 * merge. The result still has to pass {@link updateProfileSchema}: the stored
 * half never went through this request's validation.
 */
function mergeIntoStored(existing: Profile, patch: UpdateProfileInput): UpdateProfileInput {
  const merged = { ...patch };

  if (patch.models) merged.models = { ...(existing.models ?? {}), ...patch.models };
  if (patch.crm_defaults) {
    merged.crm_defaults = deepMerge(existing.crm_defaults ?? {}, patch.crm_defaults);
  }

  return merged;
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

/** Read one profile. `null` when no row has that id. */
export async function getProfile(id: string): Promise<Profile | null> {
  const [row] = await selectRows(SELECT_PROFILE_BY_ID, [id]);
  return row ? toProfile(row) : null;
}

/** Read every profile, newest first. */
export async function listProfiles(): Promise<Profile[]> {
  return (await selectRows(SELECT_PROFILES)).map(toProfile);
}

/**
 * Create a profile.
 *
 * The id is generated here rather than by the database so the caller has it
 * without a second lookup.
 *
 * @throws {ProfileNameTakenError} when the name is already in use.
 */
export async function createProfile(input: CreateProfileInput): Promise<Profile> {
  const profile = createProfileSchema.parse(input);
  const id = nanoid();

  try {
    await (await appDb()).execute({
      sql: INSERT_PROFILE,
      args: [
        id,
        profile.name,
        profile.business_summary,
        profile.offer,
        toJsonColumn(profile.audiences),
        toJsonColumn(profile.default_field_hints),
        toJsonColumn(profile.crm_defaults),
        toJsonColumn(profile.models),
      ],
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProfileNameTakenError(profile.name);
    throw error;
  }

  // Read back rather than returning the input: `created_at` and `updated_at`
  // come from the database, and this proves the row is actually readable.
  const created = await getProfile(id);
  if (!created) throw new Error(`Profile ${id} was inserted but could not be read back`);

  return created;
}

/**
 * Apply a patch to a profile. `null` when no row has that id.
 *
 * The existence check is a read before the write so a missing row is a clean 404
 * rather than an `UPDATE` that reports zero affected rows.
 *
 * With `options.merge`, the object columns are merged into the stored values
 * (see {@link UpdateProfileOptions}) inside one write transaction, and the
 * merged result is validated again before anything is written. See
 * {@link mergeProfile}.
 *
 * @throws {ZodError} when the patch, or with `merge` the merged result, is
 *   invalid. Nothing is written.
 * @throws {ProfileNameTakenError} when the patch renames onto a name in use.
 * @throws {ProfileMergeConflictError} when a merge could not get the write
 *   lock on any attempt.
 */
export async function updateProfile(
  id: string,
  patch: UpdateProfileInput,
  options: UpdateProfileOptions = {}
): Promise<Profile | null> {
  if (options.merge) return mergeProfile(id, updateProfileSchema.parse(patch));

  const existing = await getProfile(id);
  if (!existing) return null;

  const validated = updateProfileSchema.parse(patch);

  try {
    await (await appDb()).execute(buildUpdate(id, validated));
  } catch (error) {
    // A patch that leaves `name` alone cannot collide, but report whatever name
    // the row would have ended up with rather than guessing.
    if (isUniqueViolation(error)) {
      throw new ProfileNameTakenError(validated.name ?? existing.name);
    }
    throw error;
  }

  return getProfile(id);
}

/**
 * How many times a merge tries to take the write lock. Each attempt re-reads
 * the row, so an attempt after another writer merges on top of its write.
 */
const MERGE_ATTEMPTS = 3;

/** Wait before attempt n + 1 is n times this, to let the other writer finish. */
const MERGE_BACKOFF_MS = 50;

/**
 * Every attempt of a merge found another writer holding the database's write
 * lock. Nothing was written. The request is safe to repeat: a repeat reads the
 * row again and merges on top of whatever the other writers left.
 */
export class ProfileMergeConflictError extends Error {
  readonly profileId: string;

  constructor(profileId: string, cause: unknown) {
    super(
      `Profile ${profileId} was changed by another request during each of ${MERGE_ATTEMPTS} merge attempts. Nothing was written; retry the request.`,
      { cause }
    );
    this.name = 'ProfileMergeConflictError';
    this.profileId = profileId;
  }
}

/**
 * The merge path of {@link updateProfile}: read, merge and write in one write
 * transaction, retried when another writer holds the lock.
 *
 * A read followed by a separate `UPDATE` would lose updates: two merges read
 * the same row, and the second write silently drops the key the first one
 * added. The transaction closes that gap, and libSQL's semantics make the
 * protection a lock rather than a merge at commit time. `transaction('write')`
 * is `BEGIN IMMEDIATE`, which takes the database's single write lock before
 * the read; SQLite allows one write transaction at a time, so no other writer
 * can change the row between this read and this write. A second merge that
 * starts meanwhile fails at its own `BEGIN IMMEDIATE` with `SQLITE_BUSY`
 * (libSQL does not wait on a busy lock for a transaction), having written
 * nothing, and its retry reads the first merge's committed row and merges on
 * top of it. On Turso, writes are serialized on the primary the same way.
 *
 * The retry covers `SQLITE_BUSY` only. A missing row, an invalid merged result
 * or a rejected write rolls back and is reported as it is.
 *
 * @throws {ProfileMergeConflictError} when every attempt found the lock held.
 */
async function mergeProfile(id: string, patch: UpdateProfileInput): Promise<Profile | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await mergeTransaction(id, patch);
    } catch (error) {
      if (!isBusy(error)) throw error;
      if (attempt >= MERGE_ATTEMPTS) throw new ProfileMergeConflictError(id, error);
      await new Promise((resolve) => setTimeout(resolve, MERGE_BACKOFF_MS * attempt));
    }
  }
}

/**
 * One attempt of {@link mergeProfile}: `BEGIN IMMEDIATE`, `SELECT`, `UPDATE`,
 * read back, `COMMIT`, all on one transaction of a client opened for this
 * attempt (see `withWriteTransaction`).
 *
 * Returns the profile as written, or `null` when no row has that id. Anything
 * that fails before the commit rolls back (`close()` rolls back a transaction
 * that was not committed), so nothing is written.
 */
async function mergeTransaction(id: string, patch: UpdateProfileInput): Promise<Profile | null> {
  return withWriteTransaction(async (transaction) => {
    let existingName: string | undefined;
    let merged: UpdateProfileInput | undefined;

    try {
      const read = await transaction.execute({ sql: SELECT_PROFILE_BY_ID, args: [id] });
      const [row] = read.rows;
      if (!row) {
        await transaction.rollback();
        return null;
      }
      const existing = toProfile({ ...row });
      existingName = existing.name;

      merged = updateProfileSchema.parse(mergeIntoStored(existing, patch));
      await transaction.execute(buildUpdate(id, merged));

      const written = await transaction.execute({ sql: SELECT_PROFILE_BY_ID, args: [id] });
      await transaction.commit();

      return toProfile({ ...written.rows[0] });
    } catch (error) {
      // As in the replace path: report the name the row would have ended up with.
      if (isUniqueViolation(error)) {
        throw new ProfileNameTakenError(merged?.name ?? existingName ?? id);
      }
      throw error;
    }
  });
}

/**
 * Delete a profile and the plans saved under it, in one write batch (one
 * transaction). `false` when no row had that id.
 */
export async function deleteProfile(id: string): Promise<boolean> {
  const [, deleted] = await (await appDb()).batch(
    [
      { sql: DELETE_PROFILE_PLANS, args: [id] },
      { sql: DELETE_PROFILE, args: [id] },
    ],
    'write'
  );

  return deleted.rowsAffected > 0;
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
