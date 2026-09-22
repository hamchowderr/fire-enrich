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

vi.mock('mysql2/promise', () => ({ default: { createPool } }));

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
      return [results.shift() ?? [], []];
    }),
  };

  createPool.mockReturnValue(pool);
  return pool;
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
