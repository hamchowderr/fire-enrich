import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import plannerFixtures from '../../fixtures/planner-plan.json';
import { TEMP_APP_DB_TIMEOUT, useTempAppDb } from '../app-db/temp-db';
import { isolateDoltEnv } from '../runs/fake-dolt';

/**
 * The saved-plans routes and data layer against a real libSQL file, one per
 * test, with no Dolt configured: saved plans live in the app's libSQL
 * database next to profiles.
 *
 * The handlers are called directly with a `NextRequest`, as the profiles route
 * tests do: what is under test is status codes and bodies — 400 with the
 * validation issues, 404 for an unknown plan or profile — that a delete
 * removes the plan row and nothing else, and the field-set lookup behind plan
 * reuse.
 */
vi.setConfig({ testTimeout: TEMP_APP_DB_TIMEOUT });

let db: ReturnType<typeof useTempAppDb>;
let restoreDolt: () => void;

/** The planner fixture's plan: a real `ResearchPlan`, for a fictional profile. */
const PLAN = JSON.parse(plannerFixtures.fixtures[0].response.content);

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
  const [collection, item, plans, profiles] = await Promise.all([
    import('@/app/api/plans/route'),
    import('@/app/api/plans/[id]/route'),
    import('@/lib/plans'),
    import('@/lib/profiles'),
  ]);
  return { collection, item, plans, profiles };
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

/** A profile to save plans under; returns its id. */
async function profileId(name = 'Example Co'): Promise<string> {
  const { profiles } = await loadRoutes();
  const profile = await profiles.createProfile({ name, business_summary: 's', offer: 'o' });
  return profile.id;
}

/** A plan whose fields are exactly `names`, grouped in one group. */
function planWith(names: string[]) {
  const [template] = PLAN.fields;
  const [group] = PLAN.groups;
  return {
    ...PLAN,
    fields: names.map((name) => ({ ...template, name, displayName: name })),
    groups: [{ ...group, fieldNames: names }],
  };
}

function body(id: string, overrides: Record<string, unknown> = {}) {
  return { profileId: id, goal: 'Find companies with a small support team', audience: 'Support leads', plan: PLAN, ...overrides };
}

describe('GET /api/plans', () => {
  it("returns the profile's plans newest first, with the plan parsed", async () => {
    const id = await profileId();
    const { collection, plans } = await loadRoutes();
    const first = await plans.savePlan(body(id));
    const second = await plans.savePlan(body(id, { goal: 'Another goal' }));
    await plans.savePlan(body(await profileId('Other Co')));

    const response = await collection.GET(list(`?profileId=${id}`));
    const json = await response.json();

    expect(response.status).toBe(200);
    const expected = [first, second].sort((a, b) =>
      a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1
    );
    expect(json.plans.map((plan: { id: string }) => plan.id)).toEqual(expected.map((plan) => plan.id));
    expect(json.plans[0].plan).toEqual(PLAN);
    expect(plans.savedPlanSchema.parse(json.plans[0])).toEqual(json.plans[0]);
  });

  it('returns an empty list rather than 404 when the profile has no plans', async () => {
    const { collection } = await loadRoutes();

    const response = await collection.GET(list('?profileId=p1'));

    expect(response.status).toBe(200);
    expect((await response.json()).plans).toEqual([]);
  });

  it('answers 400 naming profileId when the query has none', async () => {
    const { collection } = await loadRoutes();

    const response = await collection.GET(list());
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe('Invalid query');
    expect(json.issues.map((issue: { path: string[] }) => issue.path.join('.'))).toContain('profileId');
  });
});

describe('POST /api/plans', () => {
  it('saves the plan whole and answers 201', async () => {
    const id = await profileId();
    const { collection, plans } = await loadRoutes();

    const response = await collection.POST(post(body(id)));
    const json = await response.json();

    expect(response.status).toBe(201);
    expect(json.plan).toMatchObject({ profile_id: id, audience: 'Support leads', plan: PLAN });
    expect(plans.savedPlanSchema.parse(json.plan)).toEqual(json.plan);
    expect(await plans.getPlan(json.plan.id)).toEqual(json.plan);
  });

  it('stores a missing audience as NULL', async () => {
    const id = await profileId();
    const { collection } = await loadRoutes();

    const { audience: _omitted, ...rest } = body(id);
    const response = await collection.POST(post(rest));

    expect(response.status).toBe(201);
    expect((await response.json()).plan.audience).toBeNull();
  });

  it('answers 400 with the issues when the plan is not a research plan, writing nothing', async () => {
    const id = await profileId();
    const { collection, plans } = await loadRoutes();

    const response = await collection.POST(
      post(body(id, { plan: { fields: [], groups: [], interpretation: 'x' } }))
    );
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toBe('Invalid plan');
    expect(json.issues.map((issue: { path: string[] }) => issue.path.join('.'))).toContain('plan.fields');
    expect(await plans.listPlans(id)).toEqual([]);
  });

  it('answers 400 when the profile id is missing', async () => {
    const { collection } = await loadRoutes();

    const { profileId: _omitted, ...rest } = body('p1');
    const response = await collection.POST(post(rest));

    expect(response.status).toBe(400);
    expect(
      (await response.json()).issues.map((issue: { path: string[] }) => issue.path.join('.'))
    ).toContain('profileId');
  });

  it('answers 400 for a body that is not JSON', async () => {
    const { collection } = await loadRoutes();

    const response = await collection.POST(post('not json', 'text/plain'));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/JSON/);
  });

  it('answers 404 naming the profile when it does not exist, saving nothing', async () => {
    const { collection, plans } = await loadRoutes();

    const response = await collection.POST(post(body('nope')));

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('No profile with id nope');
    expect(await plans.listPlans('nope')).toEqual([]);
  });
});

describe('GET /api/plans/:id', () => {
  it('returns the plan with its JSON parsed', async () => {
    const id = await profileId();
    const { item, plans } = await loadRoutes();
    const saved = await plans.savePlan(body(id));

    const response = await item.GET(get(saved.id), context(saved.id));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.plan).toEqual(saved);
    expect(json.plan.plan).toEqual(PLAN);
  });

  it('answers 404 naming the id when it is unknown', async () => {
    const { item } = await loadRoutes();

    const response = await item.GET(get('missing'), context('missing'));

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('No plan with id missing');
  });
});

describe('DELETE /api/plans/:id', () => {
  it('deletes the plan row only and answers 200', async () => {
    const id = await profileId();
    const { item, plans, profiles } = await loadRoutes();
    const doomed = await plans.savePlan(body(id));
    const kept = await plans.savePlan(body(id, { goal: 'Keep me' }));

    const response = await item.DELETE(del(doomed.id), context(doomed.id));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: doomed.id, deleted: true });
    expect(await plans.getPlan(doomed.id)).toBeNull();
    expect(await plans.getPlan(kept.id)).toEqual(kept);
    expect(await profiles.getProfile(id)).not.toBeNull();
  });

  it('answers 404 when the plan is missing', async () => {
    const { item } = await loadRoutes();

    const response = await item.DELETE(del('missing'), context('missing'));

    expect(response.status).toBe(404);
  });
});

describe('findPlanByFieldSet', () => {
  it('finds the exact field set in any order, names deduplicated', async () => {
    const id = await profileId();
    const { plans } = await loadRoutes();
    const saved = await plans.savePlan(body(id, { plan: planWith(['a', 'b']) }));

    const found = await plans.findPlanByFieldSet(['b', 'a', 'b']);

    expect(found).toEqual(saved);
  });

  it('prefers the smallest covering plan, then the newest', async () => {
    const id = await profileId();
    const { plans } = await loadRoutes();
    await plans.savePlan(body(id, { plan: planWith(['a', 'b', 'c', 'd']) }));
    const small = await plans.savePlan(body(id, { plan: planWith(['a', 'b', 'c']) }));
    await plans.savePlan(body(id, { plan: planWith(['a', 'x']) }));

    expect((await plans.findPlanByFieldSet(['a', 'b']))?.id).toBe(small.id);
  });

  it('breaks a tie in size towards the newest plan', async () => {
    const id = await profileId();
    const { plans } = await loadRoutes();
    const older = await plans.savePlan(body(id, { plan: planWith(['a', 'b']) }));
    const newer = await plans.savePlan(body(id, { plan: planWith(['b', 'a']) }));
    const { createClient } = await import('@libsql/client');
    const client = createClient({ url: db.url });
    await client.execute({ sql: "UPDATE research_plans SET created_at = '2000-01-01 00:00:00' WHERE id = ?", args: [older.id] });
    client.close();

    expect((await plans.findPlanByFieldSet(['a', 'b']))?.id).toBe(newer.id);
  });

  it('returns null when no saved plan covers the names', async () => {
    const id = await profileId();
    const { plans } = await loadRoutes();
    await plans.savePlan(body(id, { plan: planWith(['a', 'b']) }));

    expect(await plans.findPlanByFieldSet(['a', 'nothing_planned'])).toBeNull();
  });

  it('returns null for an empty set', async () => {
    const { plans } = await loadRoutes();

    expect(await plans.findPlanByFieldSet([])).toBeNull();
  });
});
