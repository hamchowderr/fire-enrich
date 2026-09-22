import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResearchPlanType } from '@/lib/mastra/schemas';

const HOUR = 60 * 60 * 1000;

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

/** A fresh module and a fresh cache per test: the cache lives on `globalThis`. */
async function loadCache() {
  delete (globalThis as { __fireEnrichPlanCache?: unknown }).__fireEnrichPlanCache;
  vi.resetModules();
  return import('@/lib/mastra/plan-cache');
}

let cache: Awaited<ReturnType<typeof loadCache>>;

beforeEach(async () => {
  cache = await loadCache();
});

describe('plan cache', () => {
  it('returns a stored plan for its field set in any order', () => {
    const stored = plan(['a', 'b', 'c']);
    cache.putPlan(stored, 0);

    expect(cache.getPlanForFields(['c', 'a', 'b'], 1)).toBe(stored);
  });

  it('misses on a different field set', () => {
    cache.putPlan(plan(['a', 'b']), 0);

    expect(cache.getPlanForFields(['a'], 1)).toBeNull();
    expect(cache.getPlanForFields(['a', 'b', 'c'], 1)).toBeNull();
  });

  it('ignores duplicate names in the lookup', () => {
    const stored = plan(['a', 'b']);
    cache.putPlan(stored, 0);

    expect(cache.getPlanForFields(['b', 'a', 'a'], 1)).toBe(stored);
  });

  it('expires a plan after an hour', () => {
    cache.putPlan(plan(['a']), 0);

    expect(cache.getPlanForFields(['a'], HOUR - 1)).not.toBeNull();
    expect(cache.getPlanForFields(['a'], HOUR)).toBeNull();
  });

  it('replaces the plan for a field set with the newer one', () => {
    cache.putPlan(plan(['a'], 'first'), 0);
    cache.putPlan(plan(['a'], 'second'), 1);

    expect(cache.getPlanForFields(['a'], 2)?.interpretation).toBe('second');
  });

  it('restarts the hour when a field set is stored again', () => {
    cache.putPlan(plan(['a']), 0);
    cache.putPlan(plan(['a']), HOUR - 1);

    expect(cache.getPlanForFields(['a'], HOUR + 1)).not.toBeNull();
  });
});
