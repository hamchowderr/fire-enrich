/**
 * The plan fallback: a field set with no cached plan is planned by the real
 * planner agent, answered by AIMock (`fixtures/plan-fallback.json`), then
 * reconciled with the requested fields and cached.
 *
 * The test database holds no profiles, so the planner plans for its generic profile;
 * the fixture only matches that system prompt and a goal built from the field
 * definitions, so a pass also proves the goal reached the model.
 *
 * Requires AIMock on `AIMOCK_URL` (`npm run test:ai` starts it).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { mastra } from '@/lib/mastra';
import { putPlan } from '@/lib/mastra/plan-cache';
import { fallbackGoal, reconcilePlan, resolvePlan } from '@/lib/mastra/plan-fallback';
import type { EnrichFieldDefinitionType, ResearchPlanType } from '@/lib/mastra/schemas';

import fallbackFixtures from '../../fixtures/plan-fallback.json';

const AIMOCK_URL = process.env.AIMOCK_URL as string;
const planner = mastra.getAgent('planner');
const PLANNED: ResearchPlanType = JSON.parse(fallbackFixtures.fixtures[0].response.content);

const FIELDS: EnrichFieldDefinitionType[] = [
  { name: 'support_channels', displayName: 'Support Channels', description: 'Where customers get help', type: 'array' },
  { name: 'pricing_model', displayName: 'Pricing Model', description: 'How it charges', type: 'string' },
  { name: 'help_desk_tool', displayName: 'Help Desk Tool', description: 'Ticketing product in use', type: 'string' },
];

/**
 * How many planner requests carrying a fallback goal AIMock has seen. Counted
 * by content rather than journal length, because other test files share the
 * mock and write to the journal concurrently.
 */
async function plannerCalls(): Promise<number> {
  const response = await fetch(`${AIMOCK_URL}/__aimock/journal?path=/v1/chat/completions`);
  const entries = (await response.json()) as unknown;
  if (!Array.isArray(entries)) return 0;

  return entries.filter((entry: { body?: { messages?: unknown } }) =>
    JSON.stringify(entry.body?.messages).includes('Collect these fields for a company.')
  ).length;
}

beforeAll(async () => {
  const health = await fetch(`${AIMOCK_URL}/health`).catch(() => undefined);
  if (!health?.ok) throw new Error(`AIMock is not reachable at ${AIMOCK_URL}.`);
});

beforeEach(() => {
  (globalThis as { __fireEnrichPlanCache?: Map<string, unknown> }).__fireEnrichPlanCache?.clear();
});

describe('fallbackGoal', () => {
  it('lists every requested field for the planner, with no query of its own', () => {
    const goal = fallbackGoal(FIELDS);

    expect(goal).toMatch(/^Collect these fields for a company\./);
    for (const field of FIELDS) expect(goal).toContain(`- ${field.displayName} (${field.type}): ${field.description}`);
    expect(goal).not.toMatch(/\{company\}|\{domain\}/);
  });
});

describe('reconcilePlan', () => {
  const plan = reconcilePlan(PLANNED, FIELDS);

  it('keeps exactly the requested fields, with the requested definitions', () => {
    expect(plan.fields.map((field) => field.name)).toEqual(FIELDS.map((field) => field.name));
    expect(plan.fields.find((field) => field.name === 'pricing_model')).toMatchObject({
      description: 'How it charges',
      strategy: 'browser',
    });
  });

  it('drops a field the planner added and puts a field it left out into the first group', () => {
    expect(plan.groups.map((group) => [group.id, group.fieldNames])).toEqual([
      ['support', ['support_channels', 'help_desk_tool']],
      ['pricing', ['pricing_model']],
    ]);
  });

  it('keeps the planner queries untouched', () => {
    expect(plan.groups[0].queries).toEqual(PLANNED.groups[0].queries);
  });
});

describe('resolvePlan', () => {
  it('returns a cached superset plan without calling the planner', async () => {
    putPlan(PLANNED);
    const before = await plannerCalls();

    const { plan, source } = await resolvePlan(FIELDS.slice(0, 2), { planner });

    expect(source).toBe('cache');
    expect(plan.fields.map((field) => field.name)).toEqual(['support_channels', 'pricing_model']);
    expect(await plannerCalls()).toBe(before);
  });

  it('asks the planner when nothing is cached, then caches the result', { timeout: 60_000 }, async () => {
    const first = await resolvePlan(FIELDS, { planner });

    expect(first.source).toBe('planner');
    expect(first.plan).toEqual(reconcilePlan(PLANNED, FIELDS));

    const before = await plannerCalls();
    const second = await resolvePlan(FIELDS, { planner });

    expect(second.source).toBe('cache');
    expect(second.plan).toEqual(first.plan);
    expect(await plannerCalls()).toBe(before);
  });
});
