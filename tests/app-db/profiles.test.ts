import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODEL_IDS } from '@/lib/mastra/models';

import { holdWriteLock, useTempAppDb } from './temp-db';
import { isolateDoltEnv } from '../runs/fake-dolt';

/**
 * The profiles data layer against a real libSQL file, one per test.
 *
 * No Dolt is configured anywhere in this file: profiles live in the app's
 * libSQL database, which every deployment has. What is asserted is what lands
 * in the database — JSON columns round-tripping, the unique name, the merge —
 * and the concurrency of `?merge=true`, driven by a second client that holds
 * the database's write lock the way another request would.
 */
let db: ReturnType<typeof useTempAppDb>;
let restoreDolt: () => void;

beforeEach(() => {
  restoreDolt = isolateDoltEnv();
  db = useTempAppDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  db.cleanup();
  restoreDolt();
});

async function loadProfiles() {
  vi.resetModules();
  return import('@/lib/profiles');
}

/** A read of the stored row, bypassing the module under test. */
async function storedRow(id: string) {
  const client = createClient({ url: db.url });
  try {
    const { rows } = await client.execute({ sql: 'SELECT * FROM profiles WHERE id = ?', args: [id] });
    return rows[0] ? { ...rows[0] } : undefined;
  } finally {
    client.close();
  }
}

const VALID_INPUT = {
  name: 'Example Co',
  business_summary: 'Sells example widgets.',
  offer: 'Widget subscription',
  audiences: ['founders'],
  default_field_hints: ['funding stage'],
  crm_defaults: { owner: 'sales' },
  models: { planner: 'anthropic/claude-opus-4.5' },
};

const MERGE_INPUT = {
  ...VALID_INPUT,
  models: { planner: 'anthropic/claude-opus-4.5', chat: 'openai/gpt-4.1-mini' },
  crm_defaults: { owner: 'sales', pipeline: { stage: 'lead', tags: ['a', 'b'] } },
};

describe('createProfileSchema', () => {
  it('accepts a full profile', async () => {
    const { createProfileSchema } = await loadProfiles();

    expect(createProfileSchema.safeParse(VALID_INPUT).success).toBe(true);
  });

  it('defaults the collection fields so a minimal profile is valid', async () => {
    const { createProfileSchema } = await loadProfiles();

    const parsed = createProfileSchema.parse({
      name: 'Example Co',
      business_summary: 'Sells example widgets.',
      offer: 'Widget subscription',
    });

    expect(parsed).toMatchObject({
      audiences: [],
      default_field_hints: [],
      crm_defaults: {},
      models: {},
    });
  });

  it('rejects a missing name and says which field', async () => {
    const { createProfileSchema } = await loadProfiles();

    const result = createProfileSchema.safeParse({ business_summary: 'x', offer: 'y' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('name');
  });

  it('rejects a whitespace-only name, which trims to empty', async () => {
    const { createProfileSchema } = await loadProfiles();

    expect(createProfileSchema.safeParse({ ...VALID_INPUT, name: '   ' }).success).toBe(false);
  });

  it('rejects audiences that is not an array of strings', async () => {
    const { createProfileSchema } = await loadProfiles();

    const result = createProfileSchema.safeParse({ ...VALID_INPUT, audiences: 'founders' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['audiences']);
  });

  it('rejects an unknown model role rather than silently ignoring it', async () => {
    const { createProfileSchema } = await loadProfiles();

    expect(
      createProfileSchema.safeParse({ ...VALID_INPUT, models: { plannr: 'anthropic/claude-opus-4.5' } })
        .success
    ).toBe(false);
  });

  it('accepts a models object that overrides only some roles', async () => {
    const { createProfileSchema } = await loadProfiles();

    expect(
      createProfileSchema.safeParse({ ...VALID_INPUT, models: { chat: 'openai/gpt-4.1-mini' } })
        .success
    ).toBe(true);
  });
});

describe('updateProfileSchema', () => {
  it('accepts a patch with one field', async () => {
    const { updateProfileSchema } = await loadProfiles();

    expect(updateProfileSchema.safeParse({ offer: 'New offer' }).success).toBe(true);
  });

  it('rejects an empty patch, which would record an edit that did not happen', async () => {
    const { updateProfileSchema } = await loadProfiles();

    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });

  it('still validates the fields that are present', async () => {
    const { updateProfileSchema } = await loadProfiles();

    expect(updateProfileSchema.safeParse({ audiences: [''] }).success).toBe(false);
  });
});

describe('createProfile, getProfile and listProfiles', () => {
  it('stores the JSON columns as JSON text and reads them back parsed', async () => {
    const { createProfile, getProfile } = await loadProfiles();

    const created = await createProfile(VALID_INPUT);

    expect(created).toMatchObject({ ...VALID_INPUT, id: expect.any(String) });
    expect(created.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(created.updated_at).toBe(created.created_at);
    expect(await getProfile(created.id)).toEqual(created);

    const row = await storedRow(created.id);
    expect(row?.audiences).toBe('["founders"]');
    expect(row?.crm_defaults).toBe('{"owner":"sales"}');
    expect(row?.models).toBe('{"planner":"anthropic/claude-opus-4.5"}');
  });

  it('generates a distinct id per profile', async () => {
    const { createProfile } = await loadProfiles();

    const first = await createProfile(VALID_INPUT);
    const second = await createProfile({ ...VALID_INPUT, name: 'Second Co' });

    expect(first.id).not.toBe(second.id);
  });

  it('binds the id rather than interpolating it', async () => {
    const { createProfile, getProfile, listProfiles } = await loadProfiles();
    await createProfile(VALID_INPUT);

    expect(await getProfile("' OR 1=1 --")).toBeNull();
    expect(await listProfiles()).toHaveLength(1);
  });

  it('returns null for an unknown id', async () => {
    const { getProfile } = await loadProfiles();

    expect(await getProfile('missing')).toBeNull();
  });

  it('lists newest first, and an empty list when there are none', async () => {
    const { createProfile, listProfiles } = await loadProfiles();
    expect(await listProfiles()).toEqual([]);

    const first = await createProfile(VALID_INPUT);
    const second = await createProfile({ ...VALID_INPUT, name: 'Second Co' });

    // Same second of `created_at`, so the id breaks the tie, descending.
    const expected = [first, second].sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1
    );
    expect((await listProfiles()).map((profile) => profile.id)).toEqual(expected.map((p) => p.id));
  });

  it('rejects an invalid input before touching the database', async () => {
    const { createProfile, listProfiles } = await loadProfiles();

    await expect(createProfile({ name: '' } as never)).rejects.toThrow();
    expect(await listProfiles()).toEqual([]);
  });

  it('translates a duplicate name into ProfileNameTakenError and stores nothing', async () => {
    const { createProfile, listProfiles, ProfileNameTakenError } = await loadProfiles();
    await createProfile(VALID_INPUT);

    const error = await createProfile({ ...VALID_INPUT, offer: 'Other' }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ProfileNameTakenError);
    expect(error.profileName).toBe('Example Co');
    expect(error.message).toContain('Example Co');
    // The class must not clobber Error.prototype.name, or stack traces lie.
    expect(error.name).toBe('ProfileNameTakenError');
    expect(await listProfiles()).toHaveLength(1);
  });

  it('treats names as case-sensitive, as the Dolt column did', async () => {
    const { createProfile } = await loadProfiles();
    await createProfile(VALID_INPUT);

    await expect(createProfile({ ...VALID_INPUT, name: 'example co' })).resolves.toBeTruthy();
  });
});

describe('updateProfile', () => {
  it('assigns only the fields present and returns the updated profile', async () => {
    const { createProfile, updateProfile } = await loadProfiles();
    const created = await createProfile(VALID_INPUT);

    const updated = await updateProfile(created.id, { offer: 'New offer', name: 'Renamed Co' });

    expect(updated).toMatchObject({
      ...VALID_INPUT,
      id: created.id,
      name: 'Renamed Co',
      offer: 'New offer',
      created_at: created.created_at,
    });
  });

  it('replaces a JSON column whole without merge', async () => {
    const { createProfile, updateProfile } = await loadProfiles();
    const created = await createProfile(MERGE_INPUT);

    const updated = await updateProfile(created.id, { models: { research: 'openai/gpt-4.1' } });

    expect(updated?.models).toEqual({ research: 'openai/gpt-4.1' });
  });

  it('moves updated_at on the database clock', async () => {
    const { createProfile, updateProfile } = await loadProfiles();
    const created = await createProfile(VALID_INPUT);
    const client = createClient({ url: db.url });
    await client.execute({
      sql: "UPDATE profiles SET updated_at = '2000-01-01 00:00:00' WHERE id = ?",
      args: [created.id],
    });
    client.close();

    const updated = await updateProfile(created.id, { offer: 'x' });

    expect(updated?.updated_at > '2000-01-01 00:00:00').toBe(true);
  });

  it('returns null and writes nothing when the profile is missing', async () => {
    const { listProfiles, updateProfile } = await loadProfiles();

    expect(await updateProfile('missing', { offer: 'x' })).toBeNull();
    expect(await listProfiles()).toEqual([]);
  });

  it('translates a rename onto an existing name, reporting the new name', async () => {
    const { createProfile, getProfile, updateProfile, ProfileNameTakenError } = await loadProfiles();
    const created = await createProfile(VALID_INPUT);
    await createProfile({ ...VALID_INPUT, name: 'Second Co' });

    const error = await updateProfile(created.id, { name: 'Second Co' }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ProfileNameTakenError);
    // The name the client asked for, not the row's current one.
    expect(error.profileName).toBe('Second Co');
    expect((await getProfile(created.id))?.name).toBe('Example Co');
  });

  it('rejects an invalid patch and writes nothing', async () => {
    const { createProfile, getProfile, updateProfile } = await loadProfiles();
    const created = await createProfile(VALID_INPUT);

    await expect(updateProfile(created.id, { audiences: [''] })).rejects.toThrow();
    expect(await getProfile(created.id)).toEqual(created);
  });
});

describe('updateProfile with merge', () => {
  it('merges models per role key', async () => {
    const { createProfile, updateProfile } = await loadProfiles();
    const created = await createProfile(MERGE_INPUT);

    const updated = await updateProfile(created.id, { models: { research: 'openai/gpt-4.1' } }, { merge: true });

    expect(updated?.models).toEqual({
      planner: 'anthropic/claude-opus-4.5',
      chat: 'openai/gpt-4.1-mini',
      research: 'openai/gpt-4.1',
    });
  });

  it('lets a sent role overwrite the stored one', async () => {
    const { createProfile, updateProfile } = await loadProfiles();
    const created = await createProfile(MERGE_INPUT);

    const updated = await updateProfile(created.id, { models: { planner: 'openai/gpt-4.1' } }, { merge: true });

    expect(updated?.models.planner).toBe('openai/gpt-4.1');
  });

  it('merges crm_defaults recursively, replacing arrays and scalars at their key', async () => {
    const { createProfile, updateProfile } = await loadProfiles();
    const created = await createProfile(MERGE_INPUT);

    const updated = await updateProfile(
      created.id,
      { crm_defaults: { pipeline: { tags: ['c'] }, region: 'emea' } },
      { merge: true }
    );

    expect(updated?.crm_defaults).toEqual({
      owner: 'sales',
      pipeline: { stage: 'lead', tags: ['c'] },
      region: 'emea',
    });
  });

  /**
   * Nested, because zod rebuilds the top level of `crm_defaults` and drops a
   * `__proto__` key there. One level down the value passes through untouched,
   * so this reaches the recursive merge of `pipeline`. Plain assignment there
   * would set the merged object's prototype and the key would vanish from the
   * written JSON.
   */
  it('keeps a nested __proto__ key as data rather than a prototype', async () => {
    const { createProfile, updateProfile } = await loadProfiles();
    const created = await createProfile(MERGE_INPUT);

    await updateProfile(
      created.id,
      { crm_defaults: JSON.parse('{"pipeline":{"__proto__":{"polluted":true}}}') },
      { merge: true }
    );

    expect((await storedRow(created.id))?.crm_defaults).toBe(
      '{"owner":"sales","pipeline":{"stage":"lead","tags":["a","b"],"__proto__":{"polluted":true}}}'
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('replaces the array columns and leaves scalar columns as sent', async () => {
    const { createProfile, updateProfile } = await loadProfiles();
    const created = await createProfile(MERGE_INPUT);

    const updated = await updateProfile(
      created.id,
      { audiences: ['investors'], offer: 'New offer' },
      { merge: true }
    );

    expect(updated).toMatchObject({ audiences: ['investors'], offer: 'New offer', models: MERGE_INPUT.models });
  });

  it('rolls back and writes nothing when the merged result is invalid', async () => {
    const { createProfile, getProfile, updateProfile } = await loadProfiles();
    const { ZodError } = await import('zod');
    const created = await createProfile(MERGE_INPUT);
    // A stored override for a role the schema does not know, as a row written
    // before `models` was closed to unknown keys would hold.
    const client = createClient({ url: db.url });
    await client.execute({
      sql: `UPDATE profiles SET models = '{"plannr":"anthropic/claude-opus-4.5"}' WHERE id = ?`,
      args: [created.id],
    });
    client.close();
    const before = await getProfile(created.id);

    const error = await updateProfile(
      created.id,
      { models: { research: 'openai/gpt-4.1' }, offer: 'Changed' },
      { merge: true }
    ).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ZodError);
    expect(await getProfile(created.id)).toEqual(before);
  });

  it('returns null and writes nothing when the profile is missing', async () => {
    const { listProfiles, updateProfile } = await loadProfiles();

    expect(await updateProfile('missing', { offer: 'x' }, { merge: true })).toBeNull();
    expect(await listProfiles()).toEqual([]);
  });

  it('rolls back a rename onto a taken name', async () => {
    const { createProfile, getProfile, updateProfile, ProfileNameTakenError } = await loadProfiles();
    const created = await createProfile(MERGE_INPUT);
    await createProfile({ ...VALID_INPUT, name: 'Second Co' });

    const error = await updateProfile(
      created.id,
      { name: 'Second Co', offer: 'Changed' },
      { merge: true }
    ).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ProfileNameTakenError);
    expect(error.profileName).toBe('Second Co');
    expect(await getProfile(created.id)).toMatchObject({ name: 'Example Co', offer: MERGE_INPUT.offer });
  });

  /**
   * The lost-update case. Another writer holds the write lock and adds a key
   * while this merge waits; the merge's `BEGIN IMMEDIATE` fails with
   * SQLITE_BUSY, the retry reads the row the other writer committed, and that
   * writer's key survives in what is finally written.
   */
  it('retries while another writer holds the lock, then merges on top of its write', async () => {
    const { createProfile, updateProfile } = await loadProfiles();
    const created = await createProfile(MERGE_INPUT);
    const other = await holdWriteLock(db.url);
    await other.execute(
      `UPDATE profiles SET models = json_set(models, '$.research', 'x/other') WHERE id = ?`,
      [created.id]
    );

    const merging = updateProfile(created.id, { models: { planner: 'openai/gpt-4.1' } }, { merge: true });
    // Let the first attempt run into the held lock before letting go.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await other.release();

    expect((await merging)?.models).toEqual({
      planner: 'openai/gpt-4.1',
      chat: 'openai/gpt-4.1-mini',
      research: 'x/other',
    });
  });

  it('keeps both keys when two merges run at once', async () => {
    const { createProfile, getProfile, updateProfile } = await loadProfiles();
    const created = await createProfile(MERGE_INPUT);

    await Promise.all([
      updateProfile(created.id, { models: { research: 'openai/gpt-4.1' } }, { merge: true }),
      updateProfile(created.id, { crm_defaults: { region: 'emea' } }, { merge: true }),
    ]);

    const stored = await getProfile(created.id);
    expect(stored?.models).toMatchObject({ research: 'openai/gpt-4.1', chat: 'openai/gpt-4.1-mini' });
    expect(stored?.crm_defaults).toMatchObject({ owner: 'sales', region: 'emea' });
  });

  it('gives up after three attempts that all find the lock held, and writes nothing', async () => {
    const { createProfile, getProfile, updateProfile, ProfileMergeConflictError } = await loadProfiles();
    const created = await createProfile(MERGE_INPUT);
    const other = await holdWriteLock(db.url);

    const error = await updateProfile(
      created.id,
      { models: { research: 'openai/gpt-4.1' } },
      { merge: true }
    ).catch((thrown) => thrown);
    await other.release();

    expect(error).toBeInstanceOf(ProfileMergeConflictError);
    expect(error.profileId).toBe(created.id);
    expect(error.message).toMatch(/retry the request/);
    expect(error.cause.code).toBe('SQLITE_BUSY');
    expect(await getProfile(created.id)).toEqual(created);

    // The failed attempts leave nothing behind that breaks the next merge.
    const next = await updateProfile(created.id, { models: { research: 'openai/gpt-4.1' } }, { merge: true });
    expect(next?.models.research).toBe('openai/gpt-4.1');
  });
});

describe('deleteProfile', () => {
  it('deletes the profile and the plans saved under it', async () => {
    const { createProfile, deleteProfile, getProfile } = await loadProfiles();
    const { savePlan, listPlans } = await import('@/lib/plans');
    const { default: plannerFixtures } = await import('../../fixtures/planner-plan.json');
    const created = await createProfile(VALID_INPUT);
    await savePlan({
      profileId: created.id,
      goal: 'g',
      plan: JSON.parse(plannerFixtures.fixtures[0].response.content),
    });

    expect(await deleteProfile(created.id)).toBe(true);
    expect(await getProfile(created.id)).toBeNull();
    expect(await listPlans(created.id)).toEqual([]);
  });

  it('returns false when the profile is missing', async () => {
    const { deleteProfile } = await loadProfiles();

    expect(await deleteProfile('missing')).toBe(false);
  });
});

describe('resolveProfileModels', () => {
  it('falls back to every default when the profile overrides nothing', async () => {
    const { resolveProfileModels } = await loadProfiles();

    expect(resolveProfileModels({ models: {} })).toEqual(DEFAULT_MODEL_IDS);
  });

  it('applies an override for one role and leaves the rest on defaults', async () => {
    const { resolveProfileModels } = await loadProfiles();

    const resolved = resolveProfileModels({ models: { planner: 'openai/gpt-4.1' } });

    expect(resolved.planner).toBe('openai/gpt-4.1');
    expect(resolved.research).toBe(DEFAULT_MODEL_IDS.research);
    expect(resolved.chat).toBe(DEFAULT_MODEL_IDS.chat);
  });

  it('applies overrides for every role', async () => {
    const { resolveProfileModels } = await loadProfiles();

    const models = {
      planner: 'openai/gpt-4.1',
      research: 'openai/gpt-4.1-mini',
      chat: 'openai/gpt-4o-mini',
    };

    expect(resolveProfileModels({ models })).toEqual(models);
  });

  it('falls back when models is missing, null, or the profile itself is null', async () => {
    const { resolveProfileModels } = await loadProfiles();

    expect(resolveProfileModels(null)).toEqual(DEFAULT_MODEL_IDS);
    expect(resolveProfileModels(undefined)).toEqual(DEFAULT_MODEL_IDS);
    expect(resolveProfileModels({ models: null as never })).toEqual(DEFAULT_MODEL_IDS);
  });

  it('ignores an empty-string override rather than resolving a role to ""', async () => {
    const { resolveProfileModels } = await loadProfiles();

    expect(resolveProfileModels({ models: { planner: '' } as never }).planner).toBe(
      DEFAULT_MODEL_IDS.planner
    );
  });

  it('returns a fresh object, so a caller cannot mutate the shared defaults', async () => {
    const { resolveProfileModels } = await loadProfiles();

    const resolved = resolveProfileModels({ models: {} });
    resolved.planner = 'mutated';

    expect(DEFAULT_MODEL_IDS.planner).not.toBe('mutated');
  });
});
