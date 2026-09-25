import { createServer, type IncomingMessage, type Server } from 'node:http';

import { NextRequest } from 'next/server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/generate-fields/route';
import { mastra } from '@/lib/mastra';
import { getPlanForFields } from '@/lib/mastra/plan-cache';
import { planIssues, ResearchPlan } from '@/lib/mastra/schemas';
import type { SavedPlan, SavePlanInput } from '@/lib/plans';
import type { Profile } from '@/lib/profiles';
import { FieldGenerationResponse } from '@/lib/types/field-generation';

import plannerFixtures from '../../fixtures/planner-plan.json';

/**
 * `POST /api/generate-fields` through the planner agent and AIMock.
 *
 * The model call is real Mastra code against the AIMock fixture in
 * `fixtures/planner-plan.json`; the profile lookup is mocked at
 * `lib/profiles.ts`, so no database is involved. The fixture only matches when
 * the system prompt carries the Example Co profile and the request asks for
 * JSON-schema output, so a passing test also proves the dynamic instructions
 * rendered the profile and that structured output reached the wire.
 *
 * Saved plans are mocked at `lib/plans.ts` the same way: `planId` and
 * `save: true` are tested for what the route reads and writes. No Dolt is
 * configured in any case: profiles and saved plans live in libSQL.
 *
 * Requires AIMock on `AIMOCK_URL` (`npm run test:ai` starts it).
 */
const AIMOCK_URL = process.env.AIMOCK_URL as string;
const ROUTE = '/api/generate-fields';

const [fixture, genericFixture] = plannerFixtures.fixtures;
const GOAL = fixture.match.userMessage;
const FIXTURE_PLAN = JSON.parse(fixture.response.content);
const GENERIC_GOAL = genericFixture.match.userMessage;
const GENERIC_PLAN = JSON.parse(genericFixture.response.content);

const EXAMPLE_PROFILE: Profile = {
  id: 'profile-example',
  name: 'Example Co',
  business_summary: 'Example Co makes a shared inbox for small customer support teams.',
  offer: 'A shared inbox that turns support email into assigned, tracked conversations.',
  audiences: ['Support leads at companies with fewer than ten support staff'],
  default_field_hints: ['Support channels offered', 'Help desk tool in use'],
  crm_defaults: {},
  models: {},
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
};

const { getProfile, listProfiles, getPlan, savePlan, findPlanByFieldSet } = vi.hoisted(() => ({
  getProfile: vi.fn<(id: string) => Promise<Profile | null>>(),
  listProfiles: vi.fn<() => Promise<Profile[]>>(),
  getPlan: vi.fn<(id: string) => Promise<SavedPlan | null>>(),
  savePlan: vi.fn<(input: SavePlanInput) => Promise<SavedPlan>>(),
  findPlanByFieldSet: vi.fn<(fieldNames: readonly string[]) => Promise<SavedPlan | null>>(),
}));

// Only the two reads are replaced; `resolveProfileModels` stays real so the
// planner's model choice goes through the same code as in production.
vi.mock('@/lib/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/profiles')>()),
  getProfile,
  listProfiles,
}));

// Everything the route and the plan cache read from the saved-plans layer.
vi.mock('@/lib/plans', () => ({ getPlan, savePlan, findPlanByFieldSet }));

/** A plan as `lib/plans` would read it back: the fixture plan, saved. */
const SAVED_PLAN: SavedPlan = {
  id: 'plan-saved',
  profile_id: EXAMPLE_PROFILE.id,
  goal: GOAL,
  audience: null,
  plan: FIXTURE_PLAN,
  created_at: '2026-01-01 00:00:00',
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function routeServer(): Server {
  return createServer(async (req, res) => {
    const body = await readBody(req);
    const nextRequest = new NextRequest(new URL(req.url ?? '/', 'http://localhost'), {
      method: req.method,
      headers: toHeaders(req),
      body: body.length > 0 ? body : undefined,
    });

    const response = await POST(nextRequest);

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
}

/** The chat requests AIMock received, newest last. */
async function journal(): Promise<Array<{ body?: Record<string, unknown> }>> {
  const response = await fetch(`${AIMOCK_URL}/__aimock/journal?path=/v1/chat/completions`);
  const entries = (await response.json()) as unknown;
  return Array.isArray(entries) ? entries : [];
}

const DOLT_ENV = ['DOLT_HOST', 'DOLT_PORT', 'DOLT_USER', 'DOLT_PASSWORD', 'DOLT_DATABASE'] as const;
const savedDolt: Record<string, string | undefined> = {};

let server: Server;

beforeAll(async () => {
  const health = await fetch(`${AIMOCK_URL}/health`).catch(() => undefined);
  if (!health?.ok) {
    throw new Error(
      `AIMock is not reachable at ${AIMOCK_URL}. Run \`npm run test:ai\`, or start \`npm run aimock\` in another terminal.`
    );
  }
  server = routeServer();
});

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

beforeEach(() => {
  // No Dolt: the planner asks lib/profiles (mocked above) all the same.
  for (const key of DOLT_ENV) {
    savedDolt[key] = process.env[key];
    delete process.env[key];
  }
  delete process.env.DEFAULT_PROFILE_ID;
  getProfile.mockImplementation(async (id) => (id === EXAMPLE_PROFILE.id ? EXAMPLE_PROFILE : null));
  listProfiles.mockResolvedValue([EXAMPLE_PROFILE]);
  getPlan.mockResolvedValue(null);
  findPlanByFieldSet.mockResolvedValue(null);
  savePlan.mockImplementation(async ({ profileId, goal, audience, plan }) => ({
    ...SAVED_PLAN,
    profile_id: profileId,
    goal,
    audience: audience ?? null,
    plan,
  }));
});

afterEach(() => {
  for (const key of DOLT_ENV) {
    if (savedDolt[key] === undefined) delete process.env[key];
    else process.env[key] = savedDolt[key];
  }
  vi.clearAllMocks();
});

describe(`POST ${ROUTE}`, () => {
  it('answers `{ prompt }` with the envelope the UI reads', { timeout: 30_000 }, async () => {
    const response = await request(server)
      .post(ROUTE)
      .send({ prompt: GOAL })
      .expect(200)
      .expect('Content-Type', /application\/json/);

    expect(response.body.success).toBe(true);

    const { plan, ...legacy } = response.body.data;
    // Exactly the upstream shape: every field carries only the four keys the
    // UI knows, and nothing else sits beside `fields` and `interpretation`.
    expect(FieldGenerationResponse.strict().parse(legacy)).toEqual(legacy);
    expect(legacy.fields.map(Object.keys)).toEqual(
      FIXTURE_PLAN.fields.map(() => ['displayName', 'description', 'type', 'examples'])
    );
    expect(legacy.fields.map((field: { displayName: string }) => field.displayName)).toEqual(
      FIXTURE_PLAN.fields.map((field: { displayName: string }) => field.displayName)
    );
    expect(legacy.interpretation).toBe(FIXTURE_PLAN.interpretation);
    expect(plan).toBeDefined();

    // No profile id: the newest profile was used.
    expect(listProfiles).toHaveBeenCalledOnce();
  });

  it(
    'answers `{ profileId, goal, audience }` with a plan that validates',
    { timeout: 30_000 },
    async () => {
      const response = await request(server)
        .post(ROUTE)
        .send({ profileId: EXAMPLE_PROFILE.id, goal: GOAL, audience: 'Support leads' })
        .expect(200);

      const { plan } = response.body.data;
      const parsed = ResearchPlan.parse(plan);

      expect(planIssues(parsed)).toEqual([]);
      expect(parsed.groups.length).toBeGreaterThanOrEqual(2);
      expect(parsed).toEqual(FIXTURE_PLAN);
      expect(getProfile).toHaveBeenCalledWith(EXAMPLE_PROFILE.id);

      // Not saved unless asked: no id in the response, nothing written.
      expect(response.body.data).not.toHaveProperty('planId');
      expect(savePlan).not.toHaveBeenCalled();

      // What reached the model: JSON-schema structured output, and a system
      // prompt carrying the profile, the goal and the audience.
      // The newest planner request for this goal: other test files share the mock.
      const [last] = (await journal()).filter((entry) => JSON.stringify(entry.body).includes(`Goal: ${GOAL}`)).slice(-1);
      const body = last?.body as {
        response_format?: { type?: string };
        messages?: Array<{ role: string; content: unknown }>;
      };
      const system = JSON.stringify(body.messages?.filter((message) => message.role === 'system'));

      expect(body.response_format?.type).toBe('json_schema');
      expect(system).toContain('Name: Example Co');
      expect(system).toContain(`Goal: ${GOAL}`);
      expect(system).toContain('Audience: Support leads');
    }
  );

  it('caches the plan under its field names', { timeout: 30_000 }, async () => {
    const response = await request(server)
      .post(ROUTE)
      .send({ profileId: EXAMPLE_PROFILE.id, goal: GOAL })
      .expect(200);

    const { plan } = response.body.data;
    const names = plan.fields.map((field: { name: string }) => field.name).reverse();

    expect(await getPlanForFields(names)).toEqual({ plan });
  });

  it('saves the plan under the profile with `save: true` and returns its id', { timeout: 30_000 }, async () => {
    const response = await request(server)
      .post(ROUTE)
      .send({ profileId: EXAMPLE_PROFILE.id, goal: GOAL, audience: 'Support leads', save: true })
      .expect(200);

    const { plan, planId, ...legacy } = response.body.data;
    expect(FieldGenerationResponse.strict().parse(legacy)).toEqual(legacy);
    expect(ResearchPlan.parse(plan)).toEqual(FIXTURE_PLAN);
    expect(planId).toBe('plan-saved');

    // Saved exactly as returned, under the profile and goal that were asked for.
    expect(savePlan).toHaveBeenCalledExactlyOnceWith({
      profileId: EXAMPLE_PROFILE.id,
      goal: GOAL,
      audience: 'Support leads',
      plan,
    });

    // Cached with its id, so the enrichment run that follows records it.
    const names = plan.fields.map((field: { name: string }) => field.name);
    expect(await getPlanForFields(names)).toEqual({ plan, planId: 'plan-saved' });
  });

  it('answers 400 for `save: true` without a profile id, calling nothing', async () => {
    const response = await request(server).post(ROUTE).send({ goal: GOAL, save: true }).expect(400);

    expect(response.body.error).toMatch(/profileId/);
    expect(savePlan).not.toHaveBeenCalled();
    expect(listProfiles).not.toHaveBeenCalled();
  });

  it('returns a saved plan for `planId` without calling the planner', async () => {
    getPlan.mockResolvedValue(SAVED_PLAN);
    const generate = vi.spyOn(mastra.getAgent('planner'), 'generate');

    try {
      const response = await request(server)
        .post(ROUTE)
        .send({ planId: SAVED_PLAN.id })
        .expect(200)
        .expect('Content-Type', /application\/json/);

      expect(response.body.success).toBe(true);

      const { plan, planId, ...legacy } = response.body.data;
      // The same envelope a generated plan gets, built from the saved plan.
      expect(FieldGenerationResponse.strict().parse(legacy)).toEqual(legacy);
      expect(legacy.fields.map((field: { displayName: string }) => field.displayName)).toEqual(
        FIXTURE_PLAN.fields.map((field: { displayName: string }) => field.displayName)
      );
      expect(legacy.interpretation).toBe(FIXTURE_PLAN.interpretation);
      expect(plan).toEqual(FIXTURE_PLAN);
      expect(planId).toBe(SAVED_PLAN.id);

      expect(getPlan).toHaveBeenCalledExactlyOnceWith(SAVED_PLAN.id);
      expect(generate).not.toHaveBeenCalled();
      expect(getProfile).not.toHaveBeenCalled();
      expect(listProfiles).not.toHaveBeenCalled();

      // Cached with its id like a freshly generated one.
      const names = FIXTURE_PLAN.fields.map((field: { name: string }) => field.name);
      expect(await getPlanForFields(names)).toEqual({ plan: FIXTURE_PLAN, planId: SAVED_PLAN.id });
    } finally {
      generate.mockRestore();
    }
  });

  it('answers 404 for an unknown planId', async () => {
    const response = await request(server).post(ROUTE).send({ planId: 'missing' }).expect(404);

    expect(response.body.error).toBe('No plan with id missing');
  });

  it(
    'answers the UI `{ prompt }` body with a generic plan when no profile exists',
    { timeout: 30_000 },
    async () => {
      // What the frozen UI hits on a fresh clone: no profiles, no profile id.
      listProfiles.mockResolvedValue([]);

      const response = await request(server)
        .post(ROUTE)
        .send({ prompt: GENERIC_GOAL })
        .expect(200)
        .expect('Content-Type', /application\/json/);

      expect(response.body.success).toBe(true);

      const { plan, ...legacy } = response.body.data;
      expect(FieldGenerationResponse.strict().parse(legacy)).toEqual(legacy);
      expect(legacy.fields.map((field: { displayName: string }) => field.displayName)).toEqual(
        GENERIC_PLAN.fields.map((field: { displayName: string }) => field.displayName)
      );
      expect(legacy.interpretation).toBe(GENERIC_PLAN.interpretation);
      expect(ResearchPlan.parse(plan)).toEqual(GENERIC_PLAN);

      // The profile layer had none, and the model was told so.
      expect(getProfile).not.toHaveBeenCalled();
      expect(listProfiles).toHaveBeenCalled();
      const [last] = (await journal()).filter((entry) => JSON.stringify(entry.body).includes(GENERIC_GOAL)).slice(-1);
      const system = JSON.stringify(
        (last?.body as { messages?: Array<{ role: string }> }).messages?.filter(
          (message) => message.role === 'system'
        )
      );
      expect(system).toContain('uses a generic profile');
      expect(system).not.toContain('Example Co');
    }
  );

  it('answers 404 for an unknown profile id', async () => {
    const response = await request(server)
      .post(ROUTE)
      .send({ profileId: 'missing', goal: GOAL })
      .expect(404);

    expect(response.body.error).toMatch(/missing/);
  });

  it('rejects a body with neither prompt nor goal', async () => {
    const response = await request(server).post(ROUTE).send({ audience: 'x' }).expect(400);

    expect(response.body).toEqual({ error: 'Prompt is required' });
  });

  it('rejects a body of the wrong shape with the issues', async () => {
    const response = await request(server).post(ROUTE).send({ prompt: GOAL, save: 'yes' }).expect(400);

    expect(response.body.error).toBe('Invalid request');
    expect(response.body.issues.map((issue: { path: string[] }) => issue.path.join('.'))).toContain('save');
  });

  it('rejects a non-JSON body', async () => {
    const response = await request(server)
      .post(ROUTE)
      .set('Content-Type', 'text/plain')
      .send('not json')
      .expect(400);

    expect(response.body.error).toMatch(/JSON/);
  });
});
