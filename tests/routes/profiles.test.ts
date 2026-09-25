import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { holdWriteLock, TEMP_APP_DB_TIMEOUT, useTempAppDb } from '../app-db/temp-db';
import { isolateDoltEnv } from '../runs/fake-dolt';

/**
 * The profiles routes against a real libSQL file, one per test, with no Dolt
 * configured: profiles live in the app's libSQL database, which every
 * deployment has.
 *
 * The handlers are called directly with a `NextRequest` rather than through a
 * server: there is no model call to mock and no streaming to drive. What is
 * under test is status codes and bodies — 400 with the validation issues, 404
 * for an unknown id, 409 for a taken name or a merge that never got the write
 * lock — and what the database holds afterwards.
 */
vi.setConfig({ testTimeout: TEMP_APP_DB_TIMEOUT });

let db: ReturnType<typeof useTempAppDb>;
let restoreDolt: () => void;

beforeEach(() => {
  restoreDolt = isolateDoltEnv();
  db = useTempAppDb();
});

afterEach(() => {
  db.cleanup();
  restoreDolt();
});

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

function put(id: string, body: unknown, search = '') {
  return new NextRequest(`http://127.0.0.1/api/profiles/${id}${search ? `?${search}` : ''}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(id: string) {
  return new NextRequest(`http://127.0.0.1/api/profiles/${id}`);
}

function del(id: string) {
  return new NextRequest(`http://127.0.0.1/api/profiles/${id}`, { method: 'DELETE' });
}

/** The `context` a Next.js 15 dynamic route receives: params as a promise. */
function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

const VALID_BODY = {
  name: 'Example Co',
  business_summary: 'Sells example widgets.',
  offer: 'Widget subscription',
  audiences: ['founders', 'operators'],
  default_field_hints: ['funding stage'],
  crm_defaults: { owner: 'sales' },
  models: { planner: 'anthropic/claude-opus-4.5' },
};

/** A stored profile with two model overrides and a nested CRM default. */
const MERGE_BODY = {
  ...VALID_BODY,
  models: { planner: 'anthropic/claude-opus-4.5', chat: 'openai/gpt-4.1-mini' },
  crm_defaults: { owner: 'sales', pipeline: { stage: 'lead', source: 'web' } },
};

/** Create a profile through the route and return it. */
async function created(body: Record<string, unknown> = VALID_BODY) {
  const { collection } = await loadRoutes();
  const response = await collection.POST(post(body));
  expect(response.status).toBe(201);
  return (await response.json()).profile;
}

async function stored(id: string) {
  const { item } = await loadRoutes();
  return (await (await item.GET(get(id), context(id))).json()).profile;
}

describe('GET /api/profiles', () => {
  it('works with no Dolt configured, and returns an empty list rather than 404', async () => {
    const { collection } = await loadRoutes();

    const response = await collection.GET();

    expect(response.status).toBe(200);
    expect((await response.json()).profiles).toEqual([]);
  });

  it('returns the list with JSON fields parsed', async () => {
    await created();
    await created({ ...VALID_BODY, name: 'Second Co' });
    const { collection } = await loadRoutes();

    const body = await (await collection.GET()).json();

    expect(body.profiles).toHaveLength(2);
    expect(body.profiles[0].audiences).toEqual(['founders', 'operators']);
    expect(body.profiles[0].crm_defaults).toEqual({ owner: 'sales' });
    expect(body.profiles[0].models).toEqual({ planner: 'anthropic/claude-opus-4.5' });
  });
});

describe('POST /api/profiles', () => {
  it('creates the profile and answers 201', async () => {
    const profile = await created();

    expect(profile).toMatchObject({ ...VALID_BODY, id: expect.any(String) });
    expect(await stored(profile.id)).toEqual(profile);
  });

  it('answers 400 with the issues when a required field is missing', async () => {
    const { collection } = await loadRoutes();

    const response = await collection.POST(post({ business_summary: 'x', offer: 'y' }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid profile');
    expect(body.issues.map((issue: { path: string[] }) => issue.path.join('.'))).toContain('name');
  });

  it('answers 400 and writes nothing when a field has the wrong type', async () => {
    const { collection } = await loadRoutes();

    const response = await collection.POST(post({ ...VALID_BODY, audiences: 'founders' }));

    expect(response.status).toBe(400);
    expect((await response.json()).issues[0].path).toEqual(['audiences']);
    expect((await (await collection.GET()).json()).profiles).toEqual([]);
  });

  it('answers 400 for an unknown model role', async () => {
    const { collection } = await loadRoutes();

    const response = await collection.POST(post({ ...VALID_BODY, models: { plannr: 'openai/gpt-4.1' } }));

    expect(response.status).toBe(400);
    expect((await response.json()).issues.length).toBeGreaterThan(0);
  });

  it('answers 400 for a body that is not JSON', async () => {
    const { collection } = await loadRoutes();

    const response = await collection.POST(post('not json', 'text/plain'));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/JSON/);
  });

  it('answers 409 naming the name field when the name is taken', async () => {
    await created();
    const { collection } = await loadRoutes();

    const response = await collection.POST(post(VALID_BODY));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.field).toBe('name');
    expect(body.value).toBe('Example Co');
    expect(body.error).toContain('Example Co');
  });
});

describe('GET /api/profiles/:id', () => {
  it('returns the profile', async () => {
    const profile = await created();
    const { item } = await loadRoutes();

    const response = await item.GET(get(profile.id), context(profile.id));

    expect(response.status).toBe(200);
    expect((await response.json()).profile.id).toBe(profile.id);
  });

  it('answers 404 naming the id when it is unknown', async () => {
    const { item } = await loadRoutes();

    const response = await item.GET(get('missing'), context('missing'));

    expect(response.status).toBe(404);
    expect((await response.json()).error).toContain('missing');
  });
});

describe('PUT /api/profiles/:id', () => {
  it('applies the patch and returns the updated profile', async () => {
    const profile = await created();
    const { item } = await loadRoutes();

    const response = await item.PUT(put(profile.id, { offer: 'New offer' }), context(profile.id));

    expect(response.status).toBe(200);
    expect((await response.json()).profile.offer).toBe('New offer');
  });

  it('round-trips a JSON field through the patch, replacing it whole', async () => {
    const profile = await created(MERGE_BODY);
    const { item } = await loadRoutes();

    const response = await item.PUT(
      put(profile.id, { models: { chat: 'openai/gpt-4.1-mini' } }),
      context(profile.id)
    );

    expect((await response.json()).profile.models).toEqual({ chat: 'openai/gpt-4.1-mini' });
  });

  it('answers 400 for an empty patch', async () => {
    const profile = await created();
    const { item } = await loadRoutes();

    const response = await item.PUT(put(profile.id, {}), context(profile.id));

    expect(response.status).toBe(400);
    expect((await response.json()).issues.length).toBeGreaterThan(0);
  });

  it('answers 404 when the profile is missing', async () => {
    const { item } = await loadRoutes();

    const response = await item.PUT(put('missing', { offer: 'x' }), context('missing'));

    expect(response.status).toBe(404);
  });

  it('answers 409 naming the name field when renaming onto a taken name', async () => {
    const profile = await created();
    await created({ ...VALID_BODY, name: 'Second Co' });
    const { item } = await loadRoutes();

    const response = await item.PUT(put(profile.id, { name: 'Second Co' }), context(profile.id));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.field).toBe('name');
    expect(body.value).toBe('Second Co');
    expect((await stored(profile.id)).name).toBe('Example Co');
  });
});

describe('PUT /api/profiles/:id?merge=true', () => {
  it('merges one model role into the stored overrides and returns all three', async () => {
    const profile = await created(MERGE_BODY);
    const { item } = await loadRoutes();

    const response = await item.PUT(
      put(profile.id, { models: { research: 'openai/gpt-4.1' } }, 'merge=true'),
      context(profile.id)
    );
    const all = { ...MERGE_BODY.models, research: 'openai/gpt-4.1' };

    expect(response.status).toBe(200);
    expect((await response.json()).profile.models).toEqual(all);
    expect((await stored(profile.id)).models).toEqual(all);
  });

  it('merges a nested crm_defaults key and keeps its siblings', async () => {
    const profile = await created(MERGE_BODY);
    const { item } = await loadRoutes();

    const response = await item.PUT(
      put(profile.id, { crm_defaults: { pipeline: { stage: 'qualified' } } }, 'merge=true'),
      context(profile.id)
    );

    expect((await response.json()).profile.crm_defaults).toEqual({
      owner: 'sales',
      pipeline: { stage: 'qualified', source: 'web' },
    });
  });

  it('still replaces the array columns whole', async () => {
    const profile = await created();
    const { item } = await loadRoutes();

    const response = await item.PUT(
      put(profile.id, { audiences: ['investors'] }, 'merge=true'),
      context(profile.id)
    );

    expect((await response.json()).profile.audiences).toEqual(['investors']);
  });

  it('replaces the column whole with merge=false', async () => {
    const profile = await created(MERGE_BODY);
    const { item } = await loadRoutes();

    const response = await item.PUT(
      put(profile.id, { models: { research: 'openai/gpt-4.1' } }, 'merge=false'),
      context(profile.id)
    );

    expect((await response.json()).profile.models).toEqual({ research: 'openai/gpt-4.1' });
  });

  it('answers 400 and writes nothing when the merged result is invalid', async () => {
    const profile = await created(MERGE_BODY);
    // A stored override for a role the schema does not know, as a row written
    // before `models` was closed to unknown keys would hold.
    const { createClient } = await import('@libsql/client');
    const client = createClient({ url: db.url });
    await client.execute({
      sql: `UPDATE profiles SET models = '{"plannr":"anthropic/claude-opus-4.5"}' WHERE id = ?`,
      args: [profile.id],
    });
    client.close();
    const before = await stored(profile.id);
    const { item } = await loadRoutes();

    const response = await item.PUT(
      put(profile.id, { models: { research: 'openai/gpt-4.1' }, offer: 'Changed' }, 'merge=true'),
      context(profile.id)
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid profile');
    expect(body.issues[0].path).toEqual(['models']);
    expect(await stored(profile.id)).toEqual(before);
  });

  it('answers 404 when the profile is missing', async () => {
    const { item } = await loadRoutes();

    const response = await item.PUT(put('missing', { offer: 'x' }, 'merge=true'), context('missing'));

    expect(response.status).toBe(404);
  });

  it('answers 409 with a retry hint when every merge attempt finds the write lock held', async () => {
    const profile = await created(MERGE_BODY);
    const other = await holdWriteLock(db.url);
    const { item } = await loadRoutes();

    const response = await item.PUT(
      put(profile.id, { models: { research: 'openai/gpt-4.1' } }, 'merge=true'),
      context(profile.id)
    );
    await other.release();
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain(profile.id);
    expect(body.error).toMatch(/retry the request/);
    expect(await stored(profile.id)).toEqual(profile);
  });

  it('answers 400 for a merge value other than true or false, writing nothing', async () => {
    const profile = await created();
    const { item } = await loadRoutes();

    const response = await item.PUT(
      put(profile.id, { offer: 'Changed' }, 'merge=yes'),
      context(profile.id)
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid query');
    expect(body.issues[0].path).toEqual(['merge']);
    expect(await stored(profile.id)).toEqual(profile);
  });

  it('answers 400 for a misspelled parameter rather than silently replacing', async () => {
    const profile = await created();
    const { item } = await loadRoutes();

    const response = await item.PUT(put(profile.id, { offer: 'Changed' }, 'merg=true'), context(profile.id));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid query');
    expect(body.issues[0].code).toBe('unrecognized_keys');
    expect(body.issues[0].keys).toEqual(['merg']);
    expect(await stored(profile.id)).toEqual(profile);
  });
});

describe('DELETE /api/profiles/:id', () => {
  it('deletes and answers 200', async () => {
    const profile = await created();
    const { item } = await loadRoutes();

    const response = await item.DELETE(del(profile.id), context(profile.id));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: profile.id, deleted: true });
    expect((await item.GET(get(profile.id), context(profile.id))).status).toBe(404);
  });

  it('answers 404 when the profile is missing', async () => {
    const { item } = await loadRoutes();

    const response = await item.DELETE(del('missing'), context('missing'));

    expect(response.status).toBe(404);
  });
});
