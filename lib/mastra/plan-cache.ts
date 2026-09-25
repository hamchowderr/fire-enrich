/**
 * Cache of research plans keyed by the set of field names they plan, in two
 * layers.
 *
 * The UI turns a plan into a list of fields and later sends only those fields
 * to enrichment, so the plan has to be found again from the field set alone.
 *
 * The first layer is this process's memory: entries expire after
 * {@link PLAN_TTL_MS} and nothing survives a restart, but it answers without a
 * round trip and holds plans that were never saved. The second is Dolt's
 * `research_plans` table (`lib/plans.ts`), consulted on a memory miss when
 * Dolt is configured, so a plan saved by field generation is found by an
 * enrichment run in another process, or after a restart. A saved plan found
 * there is put in memory for the rows that follow.
 *
 * A miss on both layers means "no plan", never an error; callers fall back to
 * planning without one. A Dolt failure counts as a miss too: an outage should
 * cost one planner call, not the run.
 */
import { isDoltConfigured } from '@/lib/dolt';
import { findPlanByFieldSet, type SavedPlan } from '@/lib/plans';

import type { ResearchPlanType } from './schemas';

/** How long a plan stays retrievable in memory after it is stored. */
const PLAN_TTL_MS = 60 * 60 * 1000;

/**
 * A plan with, when it was saved, the id of its `research_plans` row.
 *
 * `planId` is what a run records as `plan_id`. It is absent for a plan that
 * only exists in memory — one the planner wrote for a hand-typed field set and
 * nobody saved — and a run of such a plan records no plan.
 */
export type ResolvedPlan = { plan: ResearchPlanType; planId?: string };

type Entry = ResolvedPlan & { expiresAt: number };

/**
 * On `globalThis` for the same reason as the Mastra instance: Turbopack
 * re-evaluates route modules on edit, and a module-level Map would be emptied
 * between the request that stores a plan and the one that reads it.
 */
const globalForCache = globalThis as typeof globalThis & {
  __fireEnrichPlanCache?: Map<string, Entry>;
};

const cache: Map<string, Entry> = (globalForCache.__fireEnrichPlanCache ??= new Map());

/** Order-independent key: the same fields in any order find the same plan. */
function keyFor(fieldNames: readonly string[]): string {
  return JSON.stringify([...new Set(fieldNames)].sort());
}

/** The caller-facing view of an entry: no `expiresAt`, and no `planId` key unless there is one. */
function resolved(plan: ResearchPlanType, planId: string | undefined): ResolvedPlan {
  return planId ? { plan, planId } : { plan };
}

/**
 * Store a plan in memory under the set of its field names, replacing any
 * earlier plan for that set. `planId` is kept with it when the plan is a saved
 * one, so a later lookup can report which row it came from.
 */
export function putPlan(
  plan: ResearchPlanType,
  { planId, now = Date.now() }: { planId?: string; now?: number } = {}
): void {
  cache.set(keyFor(plan.fields.map((field) => field.name)), {
    ...resolved(plan, planId),
    expiresAt: now + PLAN_TTL_MS,
  });

  // Expired entries are otherwise only dropped when their own key is read, so
  // sweep on write to keep a long-running process from accumulating them.
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

/**
 * A plan cut down to `fieldNames`: only those fields, only the groups that
 * research at least one of them, and each group's `fieldNames` narrowed to
 * the requested ones. Order within the plan is kept.
 */
export function restrictPlan(plan: ResearchPlanType, fieldNames: readonly string[]): ResearchPlanType {
  const wanted = new Set(fieldNames);

  return {
    ...plan,
    fields: plan.fields.filter((field) => wanted.has(field.name)),
    groups: plan.groups
      .map((group) => ({ ...group, fieldNames: group.fieldNames.filter((name) => wanted.has(name)) }))
      .filter((group) => group.fieldNames.length > 0),
  };
}

/**
 * The live in-memory plan for this set of field names, or `null`.
 *
 * An exact match wins. Otherwise a plan whose field set is a superset of the
 * requested one is returned, restricted to the requested fields with
 * {@link restrictPlan}: the UI lets a user delete fields from a generated plan
 * before enriching, and the plan behind the remaining fields is still the one
 * the planner wrote. Among several supersets the smallest one wins, since it
 * was planned for the goal closest to this field set; ties go to the newest.
 */
function cachedPlanForFields(wanted: readonly string[], now: number): ResolvedPlan | null {
  const key = keyFor(wanted);
  const entry = cache.get(key);

  if (entry) {
    if (entry.expiresAt > now) return resolved(entry.plan, entry.planId);
    cache.delete(key);
  }

  let best: (Entry & { size: number }) | null = null;

  for (const [candidateKey, candidate] of cache) {
    if (candidate.expiresAt <= now) {
      cache.delete(candidateKey);
      continue;
    }

    const names = new Set(candidate.plan.fields.map((field) => field.name));
    if (!wanted.every((name) => names.has(name))) continue;

    const better =
      !best ||
      names.size < best.size ||
      (names.size === best.size && candidate.expiresAt > best.expiresAt);
    if (better) best = { ...candidate, size: names.size };
  }

  return best ? resolved(restrictPlan(best.plan, wanted), best.planId) : null;
}

/**
 * The saved plan covering this field set, or `null` — the second layer.
 *
 * Only asked when Dolt is configured; a failure to reach it is logged and
 * reported as a miss (see the module comment). A hit is stored in memory
 * whole, under its own field set, so the next row's lookup is a memory hit
 * and so it is still found as a superset by a narrower request.
 */
async function savedPlanForFields(wanted: readonly string[], now: number): Promise<ResolvedPlan | null> {
  if (!isDoltConfigured()) return null;

  let saved: SavedPlan | null;
  try {
    saved = await findPlanByFieldSet(wanted);
  } catch (error) {
    console.warn('Could not look up a saved plan; planning without one.', error);
    return null;
  }
  if (!saved) return null;

  putPlan(saved.plan, { planId: saved.id, now });

  const exact = saved.plan.fields.length === wanted.length;
  return resolved(exact ? saved.plan : restrictPlan(saved.plan, wanted), saved.id);
}

/**
 * The plan for this set of field names, with its saved id when it has one, or
 * `null` when neither layer covers it: memory first, then saved plans.
 *
 * The matching rule is the same in both layers — an exact field set, else the
 * smallest covering superset restricted to the request, newest on a tie.
 */
export async function getPlanForFields(
  fieldNames: readonly string[],
  now: number = Date.now()
): Promise<ResolvedPlan | null> {
  const wanted = [...new Set(fieldNames)];
  if (wanted.length === 0) return null;

  return cachedPlanForFields(wanted, now) ?? savedPlanForFields(wanted, now);
}
