import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MODEL_IDS } from '@/lib/mastra/models';

/**
 * The profiles data layer over a fake pool.
 *
 * `mysql2` is mocked, so these tests assert the SQL and the parameter order —
 * where a column/value mismatch or a JSON column sent as `[object Object]`
 * actually hides — and the commit that must follow every write.
 */
const createPool = vi.fn();
const createConnection = vi.fn();

vi.mock('mysql2/promise', () => ({ default: { createPool, createConnection } }));

const DOLT_ENV = ['DOLT_HOST', 'DOLT_PORT', 'DOLT_USER', 'DOLT_PASSWORD', 'DOLT_DATABASE'] as const;
const saved: Partial<Record<(typeof DOLT_ENV)[number], string | undefined>> = {};

function fakePool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const results: unknown[] = [];

  const pool = {
    calls,
    queue: (...items: unknown[]) => results.push(...items),
    end: vi.fn(async () => {}),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const next = results.shift();
      // A queued Error means "this call fails", so a test can put a driver
      // failure at any position in a multi-statement path.
      if (next instanceof Error) throw next;
      return [next ?? [], []];
    }),
  };

  createPool.mockReturnValue(pool);
  return pool;
}

/**
 * A dedicated connection, as `connect()` opens for a merge. Queued like
 * {@link fakePool}; each call hands out the next one, so a retry gets a fresh
 * connection with its own call log.
 */
function fakeConnection() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const results: unknown[] = [];

  const connection = {
    calls,
    queue: (...items: unknown[]) => results.push(...items),
    end: vi.fn(async () => {}),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const next = results.shift();
      if (next instanceof Error) throw next;
      return [next ?? [], []];
    }),
  };

  createConnection.mockResolvedValueOnce(connection);
  return connection;
}

/**
 * What `mysql2` throws when a write collides with a unique index.
 *
 * `code` is the string the driver sets; `errno` 1062 is the MySQL/Dolt number
 * behind it. Both are present so the test fails if the production check is
 * narrowed to the wrong one.
 */
function duplicateNameError() {
  return Object.assign(
    new Error("Duplicate entry 'Example Co' for key 'profiles.uq_profiles_name'"),
    { code: 'ER_DUP_ENTRY', errno: 1062 }
  );
}

async function loadProfiles() {
  vi.resetModules();
  return import('@/lib/profiles');
}

/** A stored row as the driver hands it back: JSON columns are strings. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Example Co',
    business_summary: 'Sells example widgets.',
    offer: 'Widget subscription',
    audiences: '["founders","operators"]',
    default_field_hints: '["funding stage"]',
    crm_defaults: '{"owner":"sales"}',
    models: '{"planner":"anthropic/claude-opus-4.5"}',
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
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

beforeEach(() => {
  for (const key of DOLT_ENV) saved[key] = process.env[key];
  process.env.DOLT_HOST = '127.0.0.1';
  process.env.DOLT_DATABASE = 'fire_enrich';
  createPool.mockReset();
  createConnection.mockReset();
});

afterEach(() => {
  for (const key of DOLT_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

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

    const result = createProfileSchema.safeParse({
      business_summary: 'x',
      offer: 'y',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('name');
  });

  it('rejects a whitespace-only name, which trims to empty', async () => {
    const { createProfileSchema } = await loadProfiles();

    expect(
      createProfileSchema.safeParse({ ...VALID_INPUT, name: '   ' }).success
    ).toBe(false);
  });

  it('rejects audiences that is not an array of strings', async () => {
    const { createProfileSchema } = await loadProfiles();

    const result = createProfileSchema.safeParse({ ...VALID_INPUT, audiences: 'founders' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['audiences']);
  });

  it('rejects an unknown model role rather than silently ignoring it', async () => {
    const { createProfileSchema } = await loadProfiles();

    const result = createProfileSchema.safeParse({
      ...VALID_INPUT,
      models: { plannr: 'anthropic/claude-opus-4.5' },
    });

    expect(result.success).toBe(false);
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

  it('rejects an empty patch, which would commit a change that did not happen', async () => {
    const { updateProfileSchema } = await loadProfiles();

    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });

  it('still validates the fields that are present', async () => {
    const { updateProfileSchema } = await loadProfiles();

    expect(updateProfileSchema.safeParse({ audiences: [''] }).success).toBe(false);
  });
});

/**
 * The generated `UPDATE`, read off the fake pool.
 *
 * The statement is built inside `updateProfile`, so it is asserted where it is
 * actually sent — which also proves the existence check runs first and the
 * commit runs after, rather than only that a string was assembled correctly.
 */
async function updateSql(patch: Record<string, unknown>) {
  const fake = fakePool();
  fake.queue([storedRow()], { affectedRows: 1 }, [[{ hash: 'abc' }]], [storedRow()]);
  const { updateProfile } = await loadProfiles();

  await updateProfile('p1', patch);

  return fake.calls[1];
}

describe('the generated UPDATE', () => {
  it('assigns only the fields present', async () => {
    const { sql, params } = await updateSql({ offer: 'New offer', name: 'Renamed Co' });

    expect(sql).toBe('UPDATE profiles SET name = ?, offer = ? WHERE id = ?');
    expect(params).toEqual(['Renamed Co', 'New offer', 'p1']);
  });

  /**
   * The patch is validated before it is built into SQL, and zod rebuilds the
   * object in schema-declaration order. So the column order is a property of the
   * schema, not of how the client happened to order its JSON — two clients
   * sending the same fields produce byte-identical SQL.
   */
  it('orders columns by the schema, not by the request body', async () => {
    const forwards = await updateSql({ name: 'Renamed Co', offer: 'New offer' });
    const backwards = await updateSql({ offer: 'New offer', name: 'Renamed Co' });

    expect(backwards.sql).toBe(forwards.sql);
    expect(backwards.params).toEqual(forwards.params);
  });

  it('stringifies JSON columns and leaves scalar columns alone', async () => {
    const { sql, params } = await updateSql({
      audiences: ['founders'],
      crm_defaults: { owner: 'sales' },
      offer: 'New offer',
    });

    expect(sql).toBe('UPDATE profiles SET offer = ?, audiences = ?, crm_defaults = ? WHERE id = ?');
    expect(params).toEqual(['New offer', '["founders"]', '{"owner":"sales"}', 'p1']);
  });

  it('skips a key explicitly set to undefined', async () => {
    const { sql, params } = await updateSql({ offer: 'New offer', name: undefined });

    expect(sql).toBe('UPDATE profiles SET offer = ? WHERE id = ?');
    expect(params).toEqual(['New offer', 'p1']);
  });

  it('leaves updated_at to the database rather than assigning it', async () => {
    expect((await updateSql({ offer: 'x' })).sql).not.toContain('updated_at');
  });
});

describe('getProfile and listProfiles', () => {
  it('parses every JSON column of a row', async () => {
    const fake = fakePool();
    fake.queue([storedRow()]);
    const { getProfile } = await loadProfiles();

    const profile = await getProfile('p1');

    expect(profile).toMatchObject({
      id: 'p1',
      audiences: ['founders', 'operators'],
      default_field_hints: ['funding stage'],
      crm_defaults: { owner: 'sales' },
      models: { planner: 'anthropic/claude-opus-4.5' },
    });
  });

  it('binds the id rather than interpolating it', async () => {
    const fake = fakePool();
    fake.queue([storedRow()]);
    const { getProfile } = await loadProfiles();

    await getProfile("' OR 1=1 --");

    expect(fake.calls[0].sql).toContain('WHERE id = ?');
    expect(fake.calls[0].params).toEqual(["' OR 1=1 --"]);
  });

  it('returns null for an unknown id', async () => {
    const fake = fakePool();
    fake.queue([]);
    const { getProfile } = await loadProfiles();

    expect(await getProfile('missing')).toBeNull();
  });

  it('lists newest first', async () => {
    const fake = fakePool();
    fake.queue([storedRow(), storedRow({ id: 'p2' })]);
    const { listProfiles } = await loadProfiles();

    const profiles = await listProfiles();

    expect(fake.calls[0].sql).toContain('ORDER BY created_at DESC');
    expect(profiles.map((profile) => profile.id)).toEqual(['p1', 'p2']);
  });
});

describe('createProfile', () => {
  it('inserts JSON columns as strings and commits naming the profile', async () => {
    const fake = fakePool();
    // insert, DOLT_COMMIT, read-back
    fake.queue({ affectedRows: 1 }, [[{ hash: 'abc123' }]], [storedRow()]);
    const { createProfile } = await loadProfiles();

    const profile = await createProfile(VALID_INPUT);

    const [insert, commitCall] = fake.calls;
    expect(insert.sql).toContain('INSERT INTO profiles');
    const [id, name, summary, offer, audiences, hints, crm, models] = insert.params;
    expect(typeof id).toBe('string');
    expect(name).toBe('Example Co');
    expect(summary).toBe('Sells example widgets.');
    expect(offer).toBe('Widget subscription');
    expect(audiences).toBe('["founders"]');
    expect(hints).toBe('["funding stage"]');
    expect(crm).toBe('{"owner":"sales"}');
    expect(models).toBe('{"planner":"anthropic/claude-opus-4.5"}');

    expect(commitCall.sql).toBe("CALL DOLT_COMMIT('-Am', ?, '--author', ?)");
    expect(commitCall.params[0]).toBe(`Create profile ${id} (Example Co)`);

    expect(profile.audiences).toEqual(['founders', 'operators']);
  });

  it('generates a distinct id per profile', async () => {
    const fake = fakePool();
    fake.queue(
      { affectedRows: 1 },
      [[{ hash: 'h1' }]],
      [storedRow()],
      { affectedRows: 1 },
      [[{ hash: 'h2' }]],
      [storedRow({ id: 'p2' })]
    );
    const { createProfile } = await loadProfiles();

    await createProfile(VALID_INPUT);
    await createProfile({ ...VALID_INPUT, name: 'Second Co' });

    expect(fake.calls[0].params[0]).not.toBe(fake.calls[3].params[0]);
  });

  it('rejects an invalid input before touching the database', async () => {
    const fake = fakePool();
    const { createProfile } = await loadProfiles();

    await expect(createProfile({ name: '' } as never)).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
  });

  it('translates a duplicate name into ProfileNameTakenError', async () => {
    const fake = fakePool();
    fake.queue(duplicateNameError());
    const { createProfile, ProfileNameTakenError } = await loadProfiles();

    const error = await createProfile(VALID_INPUT).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ProfileNameTakenError);
    expect(error.profileName).toBe('Example Co');
    expect(error.message).toContain('Example Co');
    // The class must not clobber Error.prototype.name, or stack traces lie.
    expect(error.name).toBe('ProfileNameTakenError');
  });

  it('writes no commit when the insert is rejected as a duplicate', async () => {
    const fake = fakePool();
    fake.queue(duplicateNameError());
    const { createProfile } = await loadProfiles();

    await createProfile(VALID_INPUT).catch(() => {});

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].sql).toContain('INSERT INTO profiles');
    expect(fake.calls.some((call) => call.sql.includes('DOLT_COMMIT'))).toBe(false);
  });

  it('propagates a non-duplicate driver failure unchanged', async () => {
    const fake = fakePool();
    fake.queue(Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' }));
    const { createProfile, ProfileNameTakenError } = await loadProfiles();

    const error = await createProfile(VALID_INPUT).catch((thrown) => thrown);

    expect(error).not.toBeInstanceOf(ProfileNameTakenError);
    expect(error.message).toBe('connection lost');
  });
});

describe('updateProfile', () => {
  it('updates and commits when the profile exists', async () => {
    const fake = fakePool();
    // existence read, update, commit, read-back
    fake.queue([storedRow()], { affectedRows: 1 }, [[{ hash: 'abc' }]], [
      storedRow({ offer: 'New offer' }),
    ]);
    const { updateProfile } = await loadProfiles();

    const profile = await updateProfile('p1', { offer: 'New offer' });

    expect(fake.calls[1].sql).toBe('UPDATE profiles SET offer = ? WHERE id = ?');
    expect(fake.calls[1].params).toEqual(['New offer', 'p1']);
    expect(fake.calls[2].params[0]).toBe('Update profile p1 (Example Co)');
    expect(profile?.offer).toBe('New offer');
  });

  it('returns null and writes nothing when the profile is missing', async () => {
    const fake = fakePool();
    fake.queue([]);
    const { updateProfile } = await loadProfiles();

    expect(await updateProfile('missing', { offer: 'x' })).toBeNull();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].sql).toContain('SELECT');
  });

  it('translates a rename onto an existing name, reporting the new name', async () => {
    const fake = fakePool();
    // existence read succeeds, then the UPDATE collides
    fake.queue([storedRow()], duplicateNameError());
    const { updateProfile, ProfileNameTakenError } = await loadProfiles();

    const error = await updateProfile('p1', { name: 'Second Co' }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ProfileNameTakenError);
    // The name the client asked for, not the row's current one.
    expect(error.profileName).toBe('Second Co');
  });

  it('writes no commit when the update is rejected as a duplicate', async () => {
    const fake = fakePool();
    fake.queue([storedRow()], duplicateNameError());
    const { updateProfile } = await loadProfiles();

    await updateProfile('p1', { name: 'Second Co' }).catch(() => {});

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].sql).toContain('UPDATE profiles');
    expect(fake.calls.some((call) => call.sql.includes('DOLT_COMMIT'))).toBe(false);
  });

  it('falls back to the row name when a patch that omits name still collides', async () => {
    const fake = fakePool();
    fake.queue([storedRow()], duplicateNameError());
    const { updateProfile } = await loadProfiles();

    const error = await updateProfile('p1', { offer: 'New offer' }).catch((thrown) => thrown);

    expect(error.profileName).toBe('Example Co');
  });
});

describe('updateProfile with merge', () => {
  const MERGE_ROW = {
    models: '{"planner":"anthropic/claude-opus-4.5","chat":"openai/gpt-4.1-mini"}',
    crm_defaults: '{"owner":"sales","pipeline":{"stage":"lead","tags":["a","b"]}}',
  };

  /**
   * Run one successful merge and return the connection it used. The
   * connection answers START TRANSACTION, the SELECT, the UPDATE and COMMIT;
   * the pool answers the Dolt commit and the read-back.
   */
  async function mergedUpdate(patch: Record<string, unknown>) {
    const row = storedRow(MERGE_ROW);
    const pool = fakePool();
    pool.queue([[{ hash: 'abc' }]], [row]);
    const connection = fakeConnection();
    connection.queue([], [row], { affectedRows: 1 }, []);
    const { updateProfile } = await loadProfiles();

    await updateProfile('p1', patch, { merge: true });

    return { pool, connection, update: connection.calls[2] };
  }

  it('reads and writes in one transaction on one connection, then commits to Dolt', async () => {
    const { pool, connection } = await mergedUpdate({ models: { research: 'openai/gpt-4.1' } });

    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(connection.calls.map((call) => call.sql)).toEqual([
      'START TRANSACTION',
      expect.stringMatching(/^SELECT .* FROM profiles WHERE id = \?$/),
      'UPDATE profiles SET models = ? WHERE id = ?',
      'COMMIT',
    ]);
    expect(connection.calls[1].params).toEqual(['p1']);
    expect(connection.end).toHaveBeenCalledTimes(1);
    // The Dolt commit and the read-back run after the SQL COMMIT, on the pool.
    expect(pool.calls.map((call) => call.sql)).toEqual([
      "CALL DOLT_COMMIT('-Am', ?, '--author', ?)",
      expect.stringContaining('SELECT'),
    ]);
    expect(pool.calls[0].params[0]).toBe('Update profile p1 (Example Co)');
  });

  it('merges models per role key', async () => {
    const { update } = await mergedUpdate({ models: { research: 'openai/gpt-4.1' } });

    expect(JSON.parse(update.params[0] as string)).toEqual({
      planner: 'anthropic/claude-opus-4.5',
      chat: 'openai/gpt-4.1-mini',
      research: 'openai/gpt-4.1',
    });
  });

  it('lets a sent role overwrite the stored one', async () => {
    const { update } = await mergedUpdate({ models: { planner: 'openai/gpt-4.1' } });

    expect(JSON.parse(update.params[0] as string).planner).toBe('openai/gpt-4.1');
  });

  it('merges crm_defaults recursively, replacing arrays and scalars at their key', async () => {
    const { update } = await mergedUpdate({
      crm_defaults: { pipeline: { tags: ['c'] }, region: 'emea' },
    });

    expect(JSON.parse(update.params[0] as string)).toEqual({
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
    const { update } = await mergedUpdate({
      crm_defaults: JSON.parse('{"pipeline":{"__proto__":{"polluted":true}}}'),
    });

    expect(update.params[0]).toBe(
      '{"owner":"sales","pipeline":{"stage":"lead","tags":["a","b"],"__proto__":{"polluted":true}}}'
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('replaces the array columns and leaves scalar columns as sent', async () => {
    const { update } = await mergedUpdate({ audiences: ['investors'], offer: 'New offer' });

    expect(update.sql).toBe('UPDATE profiles SET offer = ?, audiences = ? WHERE id = ?');
    expect(update.params).toEqual(['New offer', '["investors"]', 'p1']);
  });

  it('rolls back and writes nothing when the merged result is invalid', async () => {
    const pool = fakePool();
    const connection = fakeConnection();
    connection.queue([], [storedRow({ models: '{"plannr":"anthropic/claude-opus-4.5"}' })], []);
    const { updateProfile } = await loadProfiles();
    const { ZodError } = await import('zod');

    const error = await updateProfile(
      'p1',
      { models: { research: 'openai/gpt-4.1' } },
      { merge: true }
    ).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ZodError);
    expect(connection.calls.map((call) => call.sql)).toEqual([
      'START TRANSACTION',
      expect.stringContaining('SELECT'),
      'ROLLBACK',
    ]);
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(pool.calls).toHaveLength(0);
  });

  it('rolls back and returns null when the profile is missing', async () => {
    const pool = fakePool();
    const connection = fakeConnection();
    connection.queue([], []);
    const { updateProfile } = await loadProfiles();

    expect(await updateProfile('missing', { offer: 'x' }, { merge: true })).toBeNull();
    expect(connection.calls.map((call) => call.sql).at(-1)).toBe('ROLLBACK');
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(pool.calls).toHaveLength(0);
  });

  it('rolls back a rename onto a taken name and writes no Dolt commit', async () => {
    const pool = fakePool();
    const connection = fakeConnection();
    connection.queue([], [storedRow(MERGE_ROW)], duplicateNameError());
    const { updateProfile, ProfileNameTakenError } = await loadProfiles();

    const error = await updateProfile('p1', { name: 'Second Co' }, { merge: true }).catch(
      (thrown) => thrown
    );

    expect(error).toBeInstanceOf(ProfileNameTakenError);
    expect(error.profileName).toBe('Second Co');
    expect(connection.calls.map((call) => call.sql).at(-1)).toBe('ROLLBACK');
    expect(connection.end).toHaveBeenCalledTimes(1);
    expect(pool.calls).toHaveLength(0);
  });

  /**
   * The lost-update case: another merge committed a key between this one's
   * read and its COMMIT. Dolt refuses the COMMIT, and the retry re-reads the
   * row, so the other writer's key survives in what is finally written.
   */
  it('retries on a serialization failure and merges on top of the winning write', async () => {
    const winner = storedRow({
      models: '{"planner":"anthropic/claude-opus-4.5","chat":"openai/gpt-4.1-mini","research":"x/other"}',
    });
    const pool = fakePool();
    pool.queue([[{ hash: 'abc' }]], [winner]);
    const first = fakeConnection();
    first.queue(
      [],
      [storedRow(MERGE_ROW)],
      { affectedRows: 1 },
      new Error(
        'serialization failure: this transaction conflicts with a committed transaction from another client, try restarting transaction.'
      )
    );
    const second = fakeConnection();
    second.queue([], [winner], { affectedRows: 1 }, []);
    const { updateProfile } = await loadProfiles();

    await updateProfile('p1', { models: { planner: 'openai/gpt-4.1' } }, { merge: true });

    expect(first.calls.map((call) => call.sql).slice(-2)).toEqual(['COMMIT', 'ROLLBACK']);
    expect(first.end).toHaveBeenCalledTimes(1);
    expect(second.end).toHaveBeenCalledTimes(1);
    expect(JSON.parse(second.calls[2].params[0] as string)).toEqual({
      planner: 'openai/gpt-4.1',
      chat: 'openai/gpt-4.1-mini',
      research: 'x/other',
    });
    expect(pool.calls.filter((call) => call.sql.includes('DOLT_COMMIT'))).toHaveLength(1);
  });

  it('gives up after three serialization failures and commits nothing', async () => {
    const pool = fakePool();
    const conflict = () =>
      new Error('serialization failure: this transaction conflicts, try restarting transaction.');
    const connections = [1, 2, 3].map(() => {
      const connection = fakeConnection();
      connection.queue([], [storedRow(MERGE_ROW)], { affectedRows: 1 }, conflict());
      return connection;
    });
    const { updateProfile, ProfileMergeConflictError } = await loadProfiles();

    const error = await updateProfile(
      'p1',
      { models: { research: 'openai/gpt-4.1' } },
      { merge: true }
    ).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(ProfileMergeConflictError);
    expect(error.profileId).toBe('p1');
    expect(error.message).toMatch(/retry the request/);
    expect(error.cause.message).toMatch(/serialization failure/);
    expect(createConnection).toHaveBeenCalledTimes(3);
    for (const connection of connections) expect(connection.end).toHaveBeenCalledTimes(1);
    expect(pool.calls).toHaveLength(0);
  });

  /**
   * Once the SQL COMMIT has landed the merge is applied. A failure in the Dolt
   * commit after it must surface as it is, not replay the merge on top of
   * itself.
   */
  it('does not retry a serialization failure raised after the SQL COMMIT', async () => {
    const pool = fakePool();
    pool.queue(new Error('serialization failure: try restarting transaction.'));
    const connection = fakeConnection();
    connection.queue([], [storedRow(MERGE_ROW)], { affectedRows: 1 }, []);
    const { updateProfile, ProfileMergeConflictError } = await loadProfiles();

    const error = await updateProfile(
      'p1',
      { models: { research: 'openai/gpt-4.1' } },
      { merge: true }
    ).catch((thrown) => thrown);

    expect(error).not.toBeInstanceOf(ProfileMergeConflictError);
    expect(error.message).toMatch(/serialization failure/);
    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(connection.calls.map((call) => call.sql).at(-1)).toBe('COMMIT');
    expect(pool.calls.map((call) => call.sql)).toEqual([
      "CALL DOLT_COMMIT('-Am', ?, '--author', ?)",
    ]);
  });
});

describe('deleteProfile', () => {
  it('deletes and commits when the profile exists', async () => {
    const fake = fakePool();
    fake.queue([storedRow()], { affectedRows: 1 }, [[{ hash: 'abc' }]]);
    const { deleteProfile } = await loadProfiles();

    expect(await deleteProfile('p1')).toBe(true);
    expect(fake.calls[1].sql).toBe('DELETE FROM profiles WHERE id = ?');
    expect(fake.calls[1].params).toEqual(['p1']);
    expect(fake.calls[2].params[0]).toBe('Delete profile p1 (Example Co)');
  });

  it('returns false and writes nothing when the profile is missing', async () => {
    const fake = fakePool();
    fake.queue([]);
    const { deleteProfile } = await loadProfiles();

    expect(await deleteProfile('missing')).toBe(false);
    expect(fake.calls).toHaveLength(1);
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
