import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The profiles routes with `mysql2` mocked out.
 *
 * The handlers are called directly with a `NextRequest` rather than through a
 * server: there is no model call to mock and no streaming to drive, so a server
 * would only add a translation layer between the assertion and the handler. What
 * is under test is status codes and bodies — 400 with the validation issues, 404
 * for an unknown id, 503 when Dolt is not configured — and that every write ends
 * in a Dolt commit.
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
 * {@link fakePool}, with its own call log so a test can tell the two apart.
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

/** What `mysql2` throws when a write collides with `uq_profiles_name`. */
function duplicateNameError() {
  return Object.assign(
    new Error("Duplicate entry 'Example Co' for key 'profiles.uq_profiles_name'"),
    { code: 'ER_DUP_ENTRY', errno: 1062 }
  );
}

async function loadRoutes() {
  vi.resetModules();
  const [collection, item] = await Promise.all([
    import('@/app/api/profiles/route'),
    import('@/app/api/profiles/[id]/route'),
  ]);
  return { collection, item };
}

function post(body: unknown, contentType = 'application/json') {
  return new NextRequest('http://127.0.0.1/api/profiles', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function put(id: string, body: unknown) {
  return new NextRequest(`http://127.0.0.1/api/profiles/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function del(id: string) {
  return new NextRequest(`http://127.0.0.1/api/profiles/${id}`, { method: 'DELETE' });
}

/** The `context` a Next.js 15 dynamic route receives: params as a promise. */
function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

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

const VALID_BODY = {
  name: 'Example Co',
  business_summary: 'Sells example widgets.',
  offer: 'Widget subscription',
  audiences: ['founders'],
  default_field_hints: ['funding stage'],
  crm_defaults: { owner: 'sales' },
  models: { planner: 'anthropic/claude-opus-4.5' },
};

/** Every DOLT_COMMIT the handler made, in order. */
function commits(fake: ReturnType<typeof fakePool>) {
  return fake.calls.filter((call) => call.sql.includes('DOLT_COMMIT'));
}

beforeEach(() => {
  for (const key of DOLT_ENV) saved[key] = process.env[key];
  createPool.mockReset();
  createConnection.mockReset();
});

afterEach(() => {
  for (const key of DOLT_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('with Dolt not configured', () => {
  beforeEach(() => {
    for (const key of DOLT_ENV) delete process.env[key];
  });

  it('answers 503 on every handler, without trying to connect', async () => {
    const { collection, item } = await loadRoutes();

    const responses = await Promise.all([
      collection.GET(),
      collection.POST(post(VALID_BODY)),
      item.GET(new NextRequest('http://127.0.0.1/api/profiles/p1'), context('p1')),
      item.PUT(put('p1', { offer: 'x' }), context('p1')),
      item.DELETE(del('p1'), context('p1')),
    ]);

    for (const response of responses) expect(response.status).toBe(503);
    expect(createPool).not.toHaveBeenCalled();
  });

  it('names the variables to set so the 503 is actionable', async () => {
    const { collection } = await loadRoutes();

    const body = await (await collection.GET()).json();

    expect(body.error).toContain('DOLT_HOST');
    expect(body.error).toContain('DOLT_DATABASE');
  });
});

describe('with Dolt configured', () => {
  beforeEach(() => {
    process.env.DOLT_HOST = '127.0.0.1';
    process.env.DOLT_DATABASE = 'fire_enrich';
  });

  describe('GET /api/profiles', () => {
    it('returns the list with JSON fields parsed', async () => {
      const fake = fakePool();
      fake.queue([storedRow(), storedRow({ id: 'p2', name: 'Second Co' })]);
      const { collection } = await loadRoutes();

      const response = await collection.GET();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.profiles).toHaveLength(2);
      expect(body.profiles[0].audiences).toEqual(['founders', 'operators']);
      expect(body.profiles[0].crm_defaults).toEqual({ owner: 'sales' });
      expect(body.profiles[0].models).toEqual({ planner: 'anthropic/claude-opus-4.5' });
    });

    it('returns an empty list rather than 404 when there are no profiles', async () => {
      const fake = fakePool();
      fake.queue([]);
      const { collection } = await loadRoutes();

      const response = await collection.GET();

      expect(response.status).toBe(200);
      expect((await response.json()).profiles).toEqual([]);
    });
  });

  describe('POST /api/profiles', () => {
    it('creates the profile, commits, and answers 201', async () => {
      const fake = fakePool();
      fake.queue({ affectedRows: 1 }, [[{ hash: 'abc123' }]], [storedRow()]);
      const { collection } = await loadRoutes();

      const response = await collection.POST(post(VALID_BODY));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.profile.name).toBe('Example Co');
      expect(body.profile.audiences).toEqual(['founders', 'operators']);

      const [committed] = commits(fake);
      expect(committed).toBeDefined();
      expect(committed.params[0]).toMatch(/^Create profile .+ \(Example Co\)$/);
    });

    it('answers 400 with the issues when a required field is missing', async () => {
      fakePool();
      const { collection } = await loadRoutes();

      const response = await collection.POST(post({ business_summary: 'x', offer: 'y' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid profile');
      expect(body.issues.map((issue: { path: string[] }) => issue.path.join('.'))).toContain(
        'name'
      );
    });

    it('answers 400 and writes nothing when a field has the wrong type', async () => {
      const fake = fakePool();
      const { collection } = await loadRoutes();

      const response = await collection.POST(post({ ...VALID_BODY, audiences: 'founders' }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.issues[0].path).toEqual(['audiences']);
      expect(fake.calls).toHaveLength(0);
    });

    it('answers 400 for an unknown model role', async () => {
      fakePool();
      const { collection } = await loadRoutes();

      const response = await collection.POST(
        post({ ...VALID_BODY, models: { plannr: 'openai/gpt-4.1' } })
      );

      expect(response.status).toBe(400);
      expect((await response.json()).issues.length).toBeGreaterThan(0);
    });

    it('answers 400 for a body that is not JSON', async () => {
      fakePool();
      const { collection } = await loadRoutes();

      const response = await collection.POST(post('not json', 'text/plain'));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/JSON/);
    });

    it('answers 409 naming the name field when the name is taken', async () => {
      const fake = fakePool();
      fake.queue(duplicateNameError());
      const { collection } = await loadRoutes();

      const response = await collection.POST(post(VALID_BODY));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.field).toBe('name');
      expect(body.value).toBe('Example Co');
      expect(body.error).toContain('Example Co');
      expect(commits(fake)).toHaveLength(0);
    });

    it('lets a non-duplicate driver failure surface rather than reading as 409', async () => {
      const fake = fakePool();
      fake.queue(Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' }));
      const { collection } = await loadRoutes();

      await expect(collection.POST(post(VALID_BODY))).rejects.toThrow('connection lost');
    });
  });

  describe('GET /api/profiles/:id', () => {
    it('returns the profile', async () => {
      const fake = fakePool();
      fake.queue([storedRow()]);
      const { item } = await loadRoutes();

      const response = await item.GET(
        new NextRequest('http://127.0.0.1/api/profiles/p1'),
        context('p1')
      );

      expect(response.status).toBe(200);
      expect((await response.json()).profile.id).toBe('p1');
    });

    it('answers 404 naming the id when it is unknown', async () => {
      const fake = fakePool();
      fake.queue([]);
      const { item } = await loadRoutes();

      const response = await item.GET(
        new NextRequest('http://127.0.0.1/api/profiles/missing'),
        context('missing')
      );

      expect(response.status).toBe(404);
      expect((await response.json()).error).toContain('missing');
    });
  });

  describe('PUT /api/profiles/:id', () => {
    it('applies the patch, commits, and returns the updated profile', async () => {
      const fake = fakePool();
      fake.queue(
        [storedRow()],
        { affectedRows: 1 },
        [[{ hash: 'abc' }]],
        [storedRow({ offer: 'New offer' })]
      );
      const { item } = await loadRoutes();

      const response = await item.PUT(put('p1', { offer: 'New offer' }), context('p1'));

      expect(response.status).toBe(200);
      expect((await response.json()).profile.offer).toBe('New offer');
      expect(commits(fake)[0].params[0]).toBe('Update profile p1 (Example Co)');
    });

    it('round-trips a JSON field through the patch', async () => {
      const fake = fakePool();
      fake.queue(
        [storedRow()],
        { affectedRows: 1 },
        [[{ hash: 'abc' }]],
        [storedRow({ models: '{"chat":"openai/gpt-4.1-mini"}' })]
      );
      const { item } = await loadRoutes();

      const response = await item.PUT(
        put('p1', { models: { chat: 'openai/gpt-4.1-mini' } }),
        context('p1')
      );

      expect((await response.json()).profile.models).toEqual({ chat: 'openai/gpt-4.1-mini' });
      expect(fake.calls[1].params[0]).toBe('{"chat":"openai/gpt-4.1-mini"}');
    });

    it('answers 400 for an empty patch', async () => {
      const fake = fakePool();
      const { item } = await loadRoutes();

      const response = await item.PUT(put('p1', {}), context('p1'));

      expect(response.status).toBe(400);
      expect((await response.json()).issues.length).toBeGreaterThan(0);
      expect(fake.calls).toHaveLength(0);
    });

    it('answers 404 without committing when the profile is missing', async () => {
      const fake = fakePool();
      fake.queue([]);
      const { item } = await loadRoutes();

      const response = await item.PUT(put('missing', { offer: 'x' }), context('missing'));

      expect(response.status).toBe(404);
      expect(commits(fake)).toHaveLength(0);
    });

    it('answers 409 naming the name field when renaming onto a taken name', async () => {
      const fake = fakePool();
      fake.queue([storedRow()], duplicateNameError());
      const { item } = await loadRoutes();

      const response = await item.PUT(put('p1', { name: 'Second Co' }), context('p1'));
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.field).toBe('name');
      expect(body.value).toBe('Second Co');
      expect(commits(fake)).toHaveLength(0);
    });
  });

  describe('PUT /api/profiles/:id?merge=true', () => {
    /** A stored row with two model overrides and a nested CRM default. */
    const MERGE_ROW = {
      models: '{"planner":"anthropic/claude-opus-4.5","chat":"openai/gpt-4.1-mini"}',
      crm_defaults: '{"owner":"sales","pipeline":{"stage":"lead","source":"web"}}',
    };

    function putWithQuery(id: string, body: unknown, search: string) {
      return new NextRequest(`http://127.0.0.1/api/profiles/${id}?${search}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    /**
     * A merge that succeeds: the connection answers START TRANSACTION, the
     * SELECT, the UPDATE and COMMIT; the pool answers the Dolt commit and the
     * read-back.
     */
    function fakeMerge(row = storedRow(MERGE_ROW), readBack = row) {
      const pool = fakePool();
      pool.queue([[{ hash: 'abc' }]], [readBack]);
      const connection = fakeConnection();
      connection.queue([], [row], { affectedRows: 1 }, []);
      return { pool, connection };
    }

    /** The UPDATE the handler sent, found by its SQL rather than its position. */
    function updateCall(calls: Array<{ sql: string; params: unknown[] }>) {
      return calls.find((call) => call.sql.startsWith('UPDATE profiles'));
    }

    it('merges one model role into the stored overrides and returns all three', async () => {
      const all = {
        planner: 'anthropic/claude-opus-4.5',
        chat: 'openai/gpt-4.1-mini',
        research: 'openai/gpt-4.1',
      };
      const { pool, connection } = fakeMerge(
        storedRow(MERGE_ROW),
        storedRow({ ...MERGE_ROW, models: JSON.stringify(all) })
      );
      const { item } = await loadRoutes();

      const response = await item.PUT(
        putWithQuery('p1', { models: { research: 'openai/gpt-4.1' } }, 'merge=true'),
        context('p1')
      );

      expect(response.status).toBe(200);
      expect((await response.json()).profile.models).toEqual(all);
      expect(JSON.parse(updateCall(connection.calls)?.params[0] as string)).toEqual(all);
      expect(connection.calls.map((call) => call.sql)).toEqual([
        'START TRANSACTION',
        expect.stringContaining('SELECT'),
        'UPDATE profiles SET models = ? WHERE id = ?',
        'COMMIT',
      ]);
      expect(connection.end).toHaveBeenCalledTimes(1);
      expect(commits(pool)).toHaveLength(1);
    });

    it('merges a nested crm_defaults key and keeps its siblings', async () => {
      const { connection } = fakeMerge();
      const { item } = await loadRoutes();

      await item.PUT(
        putWithQuery('p1', { crm_defaults: { pipeline: { stage: 'qualified' } } }, 'merge=true'),
        context('p1')
      );

      expect(JSON.parse(updateCall(connection.calls)?.params[0] as string)).toEqual({
        owner: 'sales',
        pipeline: { stage: 'qualified', source: 'web' },
      });
    });

    it('still replaces the array columns whole', async () => {
      const { connection } = fakeMerge(storedRow());
      const { item } = await loadRoutes();

      await item.PUT(putWithQuery('p1', { audiences: ['investors'] }, 'merge=true'), context('p1'));

      expect(updateCall(connection.calls)?.params).toEqual(['["investors"]', 'p1']);
    });

    it('replaces the column whole without the option, and with merge=false', async () => {
      for (const search of ['', 'merge=false']) {
        const fake = fakePool();
        fake.queue([storedRow(MERGE_ROW)], { affectedRows: 1 }, [[{ hash: 'abc' }]], [
          storedRow(MERGE_ROW),
        ]);
        const { item } = await loadRoutes();

        await item.PUT(
          putWithQuery('p1', { models: { research: 'openai/gpt-4.1' } }, search),
          context('p1')
        );

        expect(updateCall(fake.calls)?.params).toEqual(['{"research":"openai/gpt-4.1"}', 'p1']);
      }
      // The replace path never opens a dedicated connection.
      expect(createConnection).not.toHaveBeenCalled();
    });

    it('answers 400, rolls back and writes nothing when the merged result is invalid', async () => {
      const pool = fakePool();
      const connection = fakeConnection();
      // A stored override for a role the schema does not know, as a row written
      // before `models` was closed to unknown keys would hold.
      connection.queue([], [storedRow({ models: '{"plannr":"anthropic/claude-opus-4.5"}' })], []);
      const { item } = await loadRoutes();

      const response = await item.PUT(
        putWithQuery('p1', { models: { research: 'openai/gpt-4.1' } }, 'merge=true'),
        context('p1')
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid profile');
      expect(body.issues[0].path).toEqual(['models']);
      expect(connection.calls.map((call) => call.sql)).toEqual([
        'START TRANSACTION',
        expect.stringContaining('SELECT'),
        'ROLLBACK',
      ]);
      expect(connection.end).toHaveBeenCalledTimes(1);
      expect(pool.calls).toHaveLength(0);
    });

    it('answers 404 without committing when the profile is missing', async () => {
      const pool = fakePool();
      const connection = fakeConnection();
      connection.queue([], []);
      const { item } = await loadRoutes();

      const response = await item.PUT(
        putWithQuery('missing', { offer: 'x' }, 'merge=true'),
        context('missing')
      );

      expect(response.status).toBe(404);
      expect(connection.calls.map((call) => call.sql).at(-1)).toBe('ROLLBACK');
      expect(pool.calls).toHaveLength(0);
    });

    it('answers 400 for a merge value other than true or false, before touching Dolt', async () => {
      const fake = fakePool();
      const { item } = await loadRoutes();

      const response = await item.PUT(
        putWithQuery('p1', { models: { research: 'openai/gpt-4.1' } }, 'merge=yes'),
        context('p1')
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid query');
      expect(body.issues[0].path).toEqual(['merge']);
      expect(fake.calls).toHaveLength(0);
      expect(createConnection).not.toHaveBeenCalled();
    });

    it('answers 400 for a misspelled parameter rather than silently replacing', async () => {
      const fake = fakePool();
      const { item } = await loadRoutes();

      const response = await item.PUT(
        putWithQuery('p1', { models: { research: 'openai/gpt-4.1' } }, 'merg=true'),
        context('p1')
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid query');
      expect(body.issues[0].code).toBe('unrecognized_keys');
      expect(body.issues[0].keys).toEqual(['merg']);
      expect(fake.calls).toHaveLength(0);
      expect(createConnection).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/profiles/:id', () => {
    it('deletes, commits, and answers 200', async () => {
      const fake = fakePool();
      fake.queue([storedRow()], { affectedRows: 1 }, [[{ hash: 'abc' }]]);
      const { item } = await loadRoutes();

      const response = await item.DELETE(del('p1'), context('p1'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'p1', deleted: true });
      expect(commits(fake)[0].params[0]).toBe('Delete profile p1 (Example Co)');
    });

    it('answers 404 without committing when the profile is missing', async () => {
      const fake = fakePool();
      fake.queue([]);
      const { item } = await loadRoutes();

      const response = await item.DELETE(del('missing'), context('missing'));

      expect(response.status).toBe(404);
      expect(commits(fake)).toHaveLength(0);
    });
  });
});
