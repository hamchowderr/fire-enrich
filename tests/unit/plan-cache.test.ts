import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavedPlan } from '@/lib/plans';
import type { ResearchPlanType } from '@/lib/mastra/schemas';

/**
 * The two-layer plan cache: memory, then saved plans in libSQL.
 *
 * `lib/plans` is mocked, so the second layer is whatever `findPlanByFieldSet`
 * is told to answer and no database is involved. No Dolt is configured in any
 * case: saved plans do not need it.
 */
const { findPlanByFieldSet } = vi.hoisted(() => ({
  findPlanByFieldSet: vi.fn<(fieldNames: readonly string[]) => Promise<SavedPlan | null>>(),
}));

vi.mock('@/lib/plans', () => ({ findPlanByFieldSet }));

const HOUR = 60 * 60 * 1000;

const DOLT_ENV = ['DOLT_HOST', 'DOLT_DATABASE'] as const;
const savedEnv: Partial<Record<(typeof DOLT_ENV)[number], string | undefined>> = {};

function plan(names: string[], interpretation = 'test plan'): ResearchPlanType {
  return {
    fields: names.map((name) => ({
      name,
      displayName: name,
      description: name,
      type: 'string',
      examples: [],
      strategy: 'search',
    })),
    groups: [
      {
        id: 'all',
        label: 'All',
        fieldNames: names,
        strategy: 'search',
        queries: ['{company}'],
        preferredSources: [],
        instructions: '',
      },
    ],
    interpretation,
  };
}

/** A plan as `lib/plans` would read it back. */
function savedPlan(stored: ResearchPlanType, id = 'plan-1'): SavedPlan {
  return {
    id,
    profile_id: 'p1',
    goal: 'test goal',
    audience: null,
    plan: stored,
    created_at: '2026-01-01 00:00:00',
  };
}

/** A fresh module and a fresh cache per test: the cache lives on `globalThis`. */
async function loadCache() {
  delete (globalThis as { __fireEnrichPlanCache?: unknown }).__fireEnrichPlanCache;
  vi.resetModules();
  return import('@/lib/mastra/plan-cache');
}

let cache: Awaited<ReturnType<typeof loadCache>>;

beforeEach(async () => {
  for (const key of DOLT_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  findPlanByFieldSet.mockReset();
  cache = await loadCache();
});

afterEach(() => {
  for (const key of DOLT_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('plan cache in memory', () => {
  it('returns a stored plan for its field set in any order', async () => {
    const stored = plan(['a', 'b', 'c']);
    cache.putPlan(stored, { now: 0 });

    const hit = await cache.getPlanForFields(['c', 'a', 'b'], 1);

    expect(hit?.plan).toBe(stored);
    // A plan nobody saved has no id, and no `planId` key at all.
    expect(hit).toEqual({ plan: stored });
    expect(hit).not.toHaveProperty('planId');
  });

  it('carries the saved id of a plan stored with one', async () => {
    const stored = plan(['a']);
    cache.putPlan(stored, { planId: 'plan-7', now: 0 });

    expect(await cache.getPlanForFields(['a'], 1)).toEqual({ plan: stored, planId: 'plan-7' });
  });

  it('misses when no cached plan covers every requested field', async () => {
    cache.putPlan(plan(['a', 'b']), { now: 0 });

    expect(await cache.getPlanForFields(['a', 'b', 'c'], 1)).toBeNull();
    expect(await cache.getPlanForFields(['c'], 1)).toBeNull();
    expect(await cache.getPlanForFields([], 1)).toBeNull();
  });

  it('returns a superset plan restricted to the requested fields, with its id', async () => {
    const stored: ResearchPlanType = {
      ...plan(['a', 'b', 'c']),
      groups: [
        { ...plan(['a', 'b']).groups[0], id: 'ab', fieldNames: ['a', 'b'] },
        { ...plan(['c']).groups[0], id: 'c', fieldNames: ['c'] },
      ],
    };
    cache.putPlan(stored, { planId: 'plan-abc', now: 0 });

    const restricted = await cache.getPlanForFields(['b'], 1);

    expect(restricted?.plan.fields.map((field) => field.name)).toEqual(['b']);
    expect(restricted?.plan.groups.map((group) => [group.id, group.fieldNames])).toEqual([['ab', ['b']]]);
    expect(restricted?.plan.interpretation).toBe(stored.interpretation);
    expect(restricted?.planId).toBe('plan-abc');
    // The cached plan itself is not narrowed.
    expect((await cache.getPlanForFields(['a', 'b', 'c'], 1))?.plan).toBe(stored);
  });

  it('prefers an exact match, then the smallest covering plan', async () => {
    cache.putPlan(plan(['a', 'b', 'c', 'd'], 'widest'), { now: 0 });
    cache.putPlan(plan(['a', 'b', 'c'], 'narrower'), { now: 0 });

    expect((await cache.getPlanForFields(['a'], 1))?.plan.interpretation).toBe('narrower');

    cache.putPlan(plan(['a'], 'exact'), { now: 0 });
    expect((await cache.getPlanForFields(['a'], 1))?.plan.interpretation).toBe('exact');
  });

  it('never serves an expired superset', async () => {
    cache.putPlan(plan(['a', 'b']), { now: 0 });

    expect(await cache.getPlanForFields(['a'], HOUR)).toBeNull();
  });

  it('ignores duplicate names in the lookup', async () => {
    const stored = plan(['a', 'b']);
    cache.putPlan(stored, { now: 0 });

    expect((await cache.getPlanForFields(['b', 'a', 'a'], 1))?.plan).toBe(stored);
  });

  it('expires a plan after an hour', async () => {
    cache.putPlan(plan(['a']), { now: 0 });

    expect(await cache.getPlanForFields(['a'], HOUR - 1)).not.toBeNull();
    expect(await cache.getPlanForFields(['a'], HOUR)).toBeNull();
  });

  it('replaces the plan for a field set with the newer one', async () => {
    cache.putPlan(plan(['a'], 'first'), { now: 0 });
    cache.putPlan(plan(['a'], 'second'), { now: 1 });

    expect((await cache.getPlanForFields(['a'], 2))?.plan.interpretation).toBe('second');
  });

  it('restarts the hour when a field set is stored again', async () => {
    cache.putPlan(plan(['a']), { now: 0 });
    cache.putPlan(plan(['a']), { now: HOUR - 1 });

    expect(await cache.getPlanForFields(['a'], HOUR + 1)).not.toBeNull();
  });

});

describe('plan cache over saved plans, with no Dolt configured', () => {
  it('consults saved plans on a miss even though Dolt is not configured', async () => {
    findPlanByFieldSet.mockResolvedValue(null);

    expect(await cache.getPlanForFields(['a'], 1)).toBeNull();
    expect(findPlanByFieldSet).toHaveBeenCalledWith(['a']);
  });

  it('answers from memory without asking for a saved plan', async () => {
    const stored = plan(['a']);
    cache.putPlan(stored, { now: 0 });

    expect((await cache.getPlanForFields(['a'], 1))?.plan).toBe(stored);
    expect(findPlanByFieldSet).not.toHaveBeenCalled();
  });

  it('asks for a saved plan on a memory miss, with the names deduplicated', async () => {
    const stored = plan(['a', 'b']);
    findPlanByFieldSet.mockResolvedValue(savedPlan(stored, 'plan-9'));

    const hit = await cache.getPlanForFields(['b', 'a', 'a'], 1);

    expect(findPlanByFieldSet).toHaveBeenCalledExactlyOnceWith(['b', 'a']);
    expect(hit).toEqual({ plan: stored, planId: 'plan-9' });
    // An exact match is returned as saved, not a narrowed copy.
    expect(hit?.plan).toBe(stored);
  });

  it('restricts a saved superset to the request and keeps the whole plan in memory', async () => {
    const stored: ResearchPlanType = {
      ...plan(['a', 'b', 'c']),
      groups: [
        { ...plan(['a', 'b']).groups[0], id: 'ab', fieldNames: ['a', 'b'] },
        { ...plan(['c']).groups[0], id: 'c', fieldNames: ['c'] },
      ],
    };
    findPlanByFieldSet.mockResolvedValue(savedPlan(stored, 'plan-abc'));

    const hit = await cache.getPlanForFields(['c'], 1);

    expect(hit?.planId).toBe('plan-abc');
    expect(hit?.plan.fields.map((field) => field.name)).toEqual(['c']);
    expect(hit?.plan.groups.map((group) => group.id)).toEqual(['c']);

    // The next lookups are memory hits: the full plan, and a superset of it.
    expect((await cache.getPlanForFields(['a', 'b', 'c'], 2))?.plan).toBe(stored);
    expect((await cache.getPlanForFields(['a'], 2))?.planId).toBe('plan-abc');
    expect(findPlanByFieldSet).toHaveBeenCalledOnce();
  });

  it('misses when no saved plan covers the fields', async () => {
    findPlanByFieldSet.mockResolvedValue(null);

    expect(await cache.getPlanForFields(['a'], 1)).toBeNull();
    expect(findPlanByFieldSet).toHaveBeenCalledOnce();
  });

  it('treats a failed lookup as a miss rather than an error', async () => {
    findPlanByFieldSet.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(await cache.getPlanForFields(['a'], 1)).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('never asks for an empty field set', async () => {
    expect(await cache.getPlanForFields([], 1)).toBeNull();
    expect(findPlanByFieldSet).not.toHaveBeenCalled();
  });
});
