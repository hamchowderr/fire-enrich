import { createServer, type IncomingMessage, type Server } from 'node:http';

import { NextRequest } from 'next/server';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/generate-fields/route';
import { getPlanForFields } from '@/lib/mastra/plan-cache';
import { planIssues, ResearchPlan } from '@/lib/mastra/schemas';
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
 * Requires AIMock on `AIMOCK_URL` (`npm run test:ai` starts it).
 */
const AIMOCK_URL = process.env.AIMOCK_URL as string;
const ROUTE = '/api/generate-fields';

const [fixture] = plannerFixtures.fixtures;
const GOAL = fixture.match.userMessage;
const FIXTURE_PLAN = JSON.parse(fixture.response.content);

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

const { getProfile, listProfiles } = vi.hoisted(() => ({
  getProfile: vi.fn<(id: string) => Promise<Profile | null>>(),
  listProfiles: vi.fn<() => Promise<Profile[]>>(),
}));

// Only the two reads are replaced; `resolveProfileModels` stays real so the
// planner's model choice goes through the same code as in production.
vi.mock('@/lib/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/profiles')>()),
  getProfile,
  listProfiles,
}));

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

const DOLT_ENV = { DOLT_HOST: '127.0.0.1', DOLT_DATABASE: 'fire_enrich_test' } as const;

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
  // Dolt "configured" so the planner asks lib/profiles, which is mocked above;
  // no connection is ever opened.
  Object.assign(process.env, DOLT_ENV);
  delete process.env.DEFAULT_PROFILE_ID;
  getProfile.mockImplementation(async (id) => (id === EXAMPLE_PROFILE.id ? EXAMPLE_PROFILE : null));
  listProfiles.mockResolvedValue([EXAMPLE_PROFILE]);
});

afterEach(() => {
  for (const key of Object.keys(DOLT_ENV)) delete process.env[key];
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

      // What reached the model: JSON-schema structured output, and a system
      // prompt carrying the profile, the goal and the audience.
      const [last] = (await journal()).slice(-1);
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

    expect(getPlanForFields(names)).toEqual(plan);
  });

  it('answers 404 for an unknown profile id', async () => {
    const response = await request(server)
      .post(ROUTE)
      .send({ profileId: 'missing', goal: GOAL })
      .expect(404);

    expect(response.body.error).toMatch(/missing/);
  });

  it('answers 503 for a profile id when Dolt is not configured', async () => {
    for (const key of Object.keys(DOLT_ENV)) delete process.env[key];

    await request(server).post(ROUTE).send({ profileId: EXAMPLE_PROFILE.id, goal: GOAL }).expect(503);
    expect(getProfile).not.toHaveBeenCalled();
  });

  it('rejects a body with neither prompt nor goal', async () => {
    const response = await request(server).post(ROUTE).send({ audience: 'x' }).expect(400);

    expect(response.body).toEqual({ error: 'Prompt is required' });
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
