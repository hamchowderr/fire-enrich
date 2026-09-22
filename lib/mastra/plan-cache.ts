/**
 * In-memory cache of research plans, keyed by the set of field names they plan.
 *
 * TEMPORARY. The UI turns a plan into a list of fields and later sends only
 * those fields to enrichment, so the plan has to be found again from the field
 * set alone. Until plans are saved (and a run carries a plan id instead), this
 * process-local cache bridges the two requests.
 *
 * Its limits are deliberate for a stopgap: entries expire after
 * {@link PLAN_TTL_MS}, the cache is per process (a serverless deployment may
 * miss), and nothing survives a restart. A miss means "no plan", never an
 * error; callers fall back to planning without one.
 */
import type { ResearchPlanType } from './schemas';

/** How long a plan stays retrievable after it is stored. */
const PLAN_TTL_MS = 60 * 60 * 1000;

type Entry = { plan: ResearchPlanType; expiresAt: number };

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

/** Store a plan under the set of its field names, replacing any earlier plan for that set. */
export function putPlan(plan: ResearchPlanType, now: number = Date.now()): void {
  cache.set(keyFor(plan.fields.map((field) => field.name)), {
    plan,
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
 * The live plan for this set of field names, or `null` when none covers it.
 *
 * An exact match wins. Otherwise a plan whose field set is a superset of the
 * requested one is returned, restricted to the requested fields with
 * {@link restrictPlan}: the UI lets a user delete fields from a generated plan
 * before enriching, and the plan behind the remaining fields is still the one
 * the planner wrote. Among several supersets the smallest one wins, since it
 * was planned for the goal closest to this field set; ties go to the newest.
 */
export function getPlanForFields(
  fieldNames: readonly string[],
  now: number = Date.now()
): ResearchPlanType | null {
  const key = keyFor(fieldNames);
  const entry = cache.get(key);

  if (entry) {
    if (entry.expiresAt > now) return entry.plan;
    cache.delete(key);
  }

  const wanted = [...new Set(fieldNames)];
  if (wanted.length === 0) return null;

  let best: { plan: ResearchPlanType; size: number; expiresAt: number } | null = null;

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
    if (better) best = { plan: candidate.plan, size: names.size, expiresAt: candidate.expiresAt };
  }

  return best ? restrictPlan(best.plan, wanted) : null;
}
