import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import plannerFixtures from '../../fixtures/planner-plan.json';

/**
 * The saved-plans routes and data layer with `mysql2` mocked out.
 *
 * The handlers are called directly with a `NextRequest`, as the profiles route
 * tests do: what is under test is status codes and bodies — 400 with the
 * validation issues, 404 for an unknown plan or profile, 503 when Dolt is not
 * configured — that every write ends in exactly one Dolt commit, that a delete
 * touches the plan row and nothing else, and the SQL behind the field-set
 * lookup.
 */
const createPool = vi.fn();

vi.mock('mysql2/promise', () => ({ default: { createPool } }));

const DOLT_ENV = ['DOLT_HOST', 'DOLT_PORT', 'DOLT_USER', 'DOLT_PASSWORD', 'DOLT_DATABASE'] as const;
const saved: Partial<Record<(typeof DOLT_ENV)[number], string | undefined>> = {};

/** The planner fixture's plan: a real `ResearchPlan`, for a fictional profile. */
const PLAN = JSON.parse(plannerFixtures.fixtures[0].response.content);

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

/** What `mysql2` throws when an insert names a profile that does not exist. */
function missingProfileError() {
  return Object.assign(
    new Error(
      'cannot add or update a child row - Foreign key violation on fk: `fk_research_plans_profile`, table: `research_plans`, referenced table: `profiles`, key: `[nope]`'
    ),
    { code: 'ER_NO_REFERENCED_ROW_2', errno: 1452 }
  );
}

async function loadRoutes() {
  vi.resetModules();
  const [collection, item, plans] = await Promise.all([
    import('@/app/api/plans/route'),
    import('@/app/api/plans/[id]/route'),
    import('@/lib/plans'),
  ]);
  return { collection, item, plans };
}

function list(query = '') {
  return new NextRequest(`http://127.0.0.1/api/plans${query}`);
}

function post(body: unknown, contentType = 'application/json') {
  return new NextRequest('http://127.0.0.1/api/plans', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function get(id: string) {
  return new NextRequest(`http://127.0.0.1/api/plans/${id}`);
}

function del(id: string) {
  return new NextRequest(`http://127.0.0.1/api/plans/${id}`, { method: 'DELETE' });
}

/** The `context` a Next.js 15 dynamic route receives: params as a promise. */
function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** A stored row as the driver hands it back: the JSON column is a string. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'plan-1',
    profile_id: 'p1',
    goal: 'Find companies with a small support team',
    audience: null,
    plan: JSON.stringify(PLAN),
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

const VALID_BODY = {
  profileId: 'p1',
  goal: 'Find companies with a small support team',
  audience: 'Support leads',
  plan: PLAN,
};

/** Every DOLT_COMMIT the handler made, in order. */
function commits(fake: ReturnType<typeof fakePool>) {
  return fake.calls.filter((call) => call.sql.includes('DOLT_COMMIT'));
}

/** Every statement that names a table other than `research_plans`. */
function otherTables(fake: ReturnType<typeof fakePool>) {
  return fake.calls.filter((call) => /enrichment_runs|enrichments|evidence|profiles/.test(call.sql));
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
      collection.GET(list('?profileId=p1')),
      collection.POST(post(VALID_BODY)),
      item.GET(get('plan-1'), context('plan-1')),
      item.DELETE(del('plan-1'), context('plan-1')),
    ]);

    for (const response of responses) expect(response.status).toBe(503);
    expect(createPool).not.toHaveBeenCalled();
  });

  it('names the feature and the variables to set so the 503 is actionable', async () => {
    const { collection } = await loadRoutes();

    const body = await (await collection.GET(list('?profileId=p1'))).json();

    expect(body.error).toMatch(/^Saved plans need/);
    expect(body.error).toContain('DOLT_HOST');
    expect(body.error).toContain('DOLT_DATABASE');
  });
});

describe('with Dolt configured', () => {
  beforeEach(() => {
    process.env.DOLT_HOST = '127.0.0.1';
    process.env.DOLT_DATABASE = 'fire_enrich';
  });

  describe('GET /api/plans', () => {
    it("returns the profile's plans newest first, with the plan parsed", async () => {
      const fake = fakePool();
      fake.queue([storedRow(), storedRow({ id: 'plan-2' })]);
      const { collection, plans } = await loadRoutes();

      const response = await collection.GET(list('?profileId=p1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.plans.map((plan: { id: string }) => plan.id)).toEqual(['plan-1', 'plan-2']);
      expect(body.plans[0].plan).toEqual(PLAN);
      expect(plans.savedPlanSchema.parse(body.plans[0])).toEqual(body.plans[0]);

      expect(fake.calls[0].sql).toContain('WHERE profile_id = ?');
      expect(fake.calls[0].sql).toContain('ORDER BY created_at DESC');
      expect(fake.calls[0].params).toEqual(['p1']);
    });

    it('returns an empty list rather than 404 when the profile has no plans', async () => {
      const fake = fakePool();
      fake.queue([]);
      const { collection } = await loadRoutes();

      const response = await collection.GET(list('?profileId=p1'));

      expect(response.status).toBe(200);
      expect((await response.json()).plans).toEqual([]);
    });

    it('answers 400 naming profileId when the query has none, and reads nothing', async () => {
      const fake = fakePool();
      const { collection } = await loadRoutes();

      const response = await collection.GET(list());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid query');
      expect(body.issues.map((issue: { path: string[] }) => issue.path.join('.'))).toContain(
        'profileId'
      );
      expect(fake.calls).toHaveLength(0);
    });
  });

  describe('POST /api/plans', () => {
    it('saves the plan whole, commits once, and answers 201', async () => {
      const fake = fakePool();
      // insert, DOLT_COMMIT, read-back
      fake.queue({ affectedRows: 1 }, [[{ hash: 'abc123' }]], [storedRow({ audience: 'Support leads' })]);
      const { collection, plans } = await loadRoutes();

      const response = await collection.POST(post(VALID_BODY));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.plan.id).toBe('plan-1');
      expect(body.plan.plan).toEqual(PLAN);
      expect(plans.savedPlanSchema.parse(body.plan)).toEqual(body.plan);

      const [insert] = fake.calls;
      expect(insert.sql).toContain('INSERT INTO research_plans');
      const [id, profileId, goal, audience, plan] = insert.params;
      expect(typeof id).toBe('string');
      expect(profileId).toBe('p1');
      expect(goal).toBe(VALID_BODY.goal);
      expect(audience).toBe('Support leads');
      expect(plan).toBe(JSON.stringify(PLAN));

      const committed = commits(fake);
      expect(committed).toHaveLength(1);
      expect(committed[0].params[0]).toBe(`Save plan ${id} for profile p1`);
    });

    it('stores a missing audience as NULL', async () => {
      const fake = fakePool();
      fake.queue({ affectedRows: 1 }, [[{ hash: 'abc' }]], [storedRow()]);
      const { collection } = await loadRoutes();

      const { audience: _omitted, ...body } = VALID_BODY;
      const response = await collection.POST(post(body));

      expect(response.status).toBe(201);
      expect(fake.calls[0].params[3]).toBeNull();
      expect((await response.json()).plan.audience).toBeNull();
    });

    it('answers 400 with the issues when the plan is not a research plan, writing nothing', async () => {
      const fake = fakePool();
      const { collection } = await loadRoutes();

      const response = await collection.POST(
        post({ ...VALID_BODY, plan: { fields: [], groups: [], interpretation: 'x' } })
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid plan');
      expect(body.issues.map((issue: { path: string[] }) => issue.path.join('.'))).toContain(
        'plan.fields'
      );
      expect(fake.calls).toHaveLength(0);
    });

    it('answers 400 when the profile id is missing', async () => {
      fakePool();
      const { collection } = await loadRoutes();

      const { profileId: _omitted, ...body } = VALID_BODY;
      const response = await collection.POST(post(body));

      expect(response.status).toBe(400);
      expect(
        (await response.json()).issues.map((issue: { path: string[] }) => issue.path.join('.'))
      ).toContain('profileId');
    });

    it('answers 400 for a body that is not JSON', async () => {
      fakePool();
      const { collection } = await loadRoutes();

      const response = await collection.POST(post('not json', 'text/plain'));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toMatch(/JSON/);
    });

    it('answers 404 naming the profile when it does not exist, without committing', async () => {
      const fake = fakePool();
      fake.queue(missingProfileError());
      const { collection } = await loadRoutes();

      const response = await collection.POST(post({ ...VALID_BODY, profileId: 'nope' }));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('No profile with id nope');
      expect(commits(fake)).toHaveLength(0);
    });

    it('lets a non-reference driver failure surface rather than reading as 404', async () => {
      const fake = fakePool();
      fake.queue(Object.assign(new Error('connection lost'), { code: 'PROTOCOL_CONNECTION_LOST' }));
      const { collection } = await loadRoutes();

      await expect(collection.POST(post(VALID_BODY))).rejects.toThrow('connection lost');
    });
  });

  describe('GET /api/plans/:id', () => {
    it('returns the plan with its JSON parsed', async () => {
      const fake = fakePool();
      fake.queue([storedRow()]);
      const { item, plans } = await loadRoutes();

      const response = await item.GET(get('plan-1'), context('plan-1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.plan.id).toBe('plan-1');
      expect(body.plan.plan).toEqual(PLAN);
      expect(plans.savedPlanSchema.parse(body.plan)).toEqual(body.plan);
      expect(fake.calls[0].sql).toContain('WHERE id = ?');
      expect(fake.calls[0].params).toEqual(['plan-1']);
    });

    it('answers 404 naming the id when it is unknown', async () => {
      const fake = fakePool();
      fake.queue([]);
      const { item } = await loadRoutes();

      const response = await item.GET(get('missing'), context('missing'));

      expect(response.status).toBe(404);
      expect((await response.json()).error).toBe('No plan with id missing');
    });
  });

  describe('DELETE /api/plans/:id', () => {
    it('deletes the plan row only, commits once, and answers 200', async () => {
      const fake = fakePool();
      // existence read, delete, DOLT_COMMIT
      fake.queue([storedRow()], { affectedRows: 1 }, [[{ hash: 'abc' }]]);
      const { item } = await loadRoutes();

      const response = await item.DELETE(del('plan-1'), context('plan-1'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'plan-1', deleted: true });

      const deletes = fake.calls.filter((call) => /^DELETE/i.test(call.sql));
      expect(deletes).toHaveLength(1);
      expect(deletes[0].sql).toBe('DELETE FROM research_plans WHERE id = ?');
      expect(deletes[0].params).toEqual(['plan-1']);
      // Runs that followed the plan are the database's business (ON DELETE
      // SET NULL); nothing here reads or writes them.
      expect(otherTables(fake)).toEqual([]);

      const committed = commits(fake);
      expect(committed).toHaveLength(1);
      expect(committed[0].params[0]).toBe('Delete plan plan-1');
    });

    it('answers 404 without deleting or committing when the plan is missing', async () => {
      const fake = fakePool();
      fake.queue([]);
      const { item } = await loadRoutes();

      const response = await item.DELETE(del('missing'), context('missing'));

      expect(response.status).toBe(404);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].sql).toMatch(/^SELECT/);
      expect(commits(fake)).toHaveLength(0);
    });
  });

  describe('findPlanByFieldSet', () => {
    it('asks for the smallest, newest covering plan in one query, names deduplicated', async () => {
      const fake = fakePool();
      fake.queue([storedRow()]);
      const { plans } = await loadRoutes();

      const found = await plans.findPlanByFieldSet(['support_channels', 'help_desk_tool', 'support_channels']);

      expect(found?.id).toBe('plan-1');
      expect(found?.plan).toEqual(PLAN);
      expect(fake.calls).toHaveLength(1);
      const { sql, params } = fake.calls[0];
      expect(sql).toContain("JSON_CONTAINS(JSON_EXTRACT(`plan`, '$.fields[*].name'), CAST(? AS JSON))");
      expect(sql).toContain("ORDER BY JSON_LENGTH(JSON_EXTRACT(`plan`, '$.fields')) ASC, created_at DESC");
      expect(sql).toContain('LIMIT 1');
      expect(params).toEqual(['["support_channels","help_desk_tool"]']);
    });

    it('returns null when no saved plan covers the names', async () => {
      const fake = fakePool();
      fake.queue([]);
      const { plans } = await loadRoutes();

      expect(await plans.findPlanByFieldSet(['nothing_planned'])).toBeNull();
    });

    it('returns null without a query for an empty set', async () => {
      const fake = fakePool();
      const { plans } = await loadRoutes();

      expect(await plans.findPlanByFieldSet([])).toBeNull();
      expect(fake.calls).toHaveLength(0);
    });
  });
});
