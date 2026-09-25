/**
 * Saved research plans — the planner's output for one profile, kept in the
 * app's libSQL database next to profiles (`lib/app-db.ts`: Turso, or the
 * local file fallback), so saved plans work with or without Dolt.
 *
 * A saved plan can be reused across runs, read back exactly as it was when a
 * run followed it, and found again from the field set an enrichment request
 * carries. It is the durable layer behind `lib/mastra/plan-cache.ts`: the
 * in-memory cache still answers first, and this module answers when that
 * misses — another process served field generation, the process restarted,
 * or the entry expired.
 *
 * A run recorded in Dolt names the plan it followed by `plan_id`, a plain
 * value: the two databases share no foreign key, so a run keeps the id of a
 * plan deleted later.
 *
 * Naming: a row is returned with its column names (`profile_id`,
 * `created_at`), as a profile is. The write input takes `profileId`, the
 * spelling the field-generation body and the `?profileId=` query already use,
 * so a client passes one value through unchanged.
 */
import { nanoid } from 'nanoid';
import { z } from 'zod';

import { appDb, parseJsonColumns, type Row, selectRows, toJsonColumn } from '@/lib/app-db';
import { ResearchPlan } from '@/lib/mastra/schemas';

/** Columns holding JSON, parsed on read and stringified on write. */
const JSON_COLUMNS = ['plan'] as const;

/**
 * What a client may send to save a plan.
 *
 * The plan is validated against the planner's own schema: a row that does not
 * parse as a `ResearchPlan` could be listed but never run, and the place to
 * find that out is the write, not an enrichment run weeks later. `audience`
 * is optional because a plan may be audience-agnostic; it is stored as NULL.
 */
export const savePlanSchema = z.object({
  profileId: z.string().trim().min(1).max(32),
  goal: z.string().trim().min(1),
  audience: z.string().trim().min(1).max(255).optional(),
  plan: ResearchPlan,
});

/**
 * A stored plan as it is read back and returned to clients.
 *
 * Rows come from the database rather than from a client, so nothing parses
 * through it in production — the write above already validated the plan, and
 * re-validating every row on every list would cost a pass per row to catch a
 * bug the write prevents.
 *
 * @public Exported so tests can check what the routes return against one
 * definition; `SavedPlan` is derived from it.
 */
export const savedPlanSchema = z.object({
  id: z.string().min(1),
  profile_id: z.string().min(1),
  goal: z.string(),
  audience: z.string().nullable(),
  plan: ResearchPlan,
  created_at: z.string(),
});

export type SavePlanInput = z.input<typeof savePlanSchema>;
export type SavedPlan = z.infer<typeof savedPlanSchema>;

/**
 * Columns selected for a plan, in a fixed order so reads are identical.
 * `plan` is quoted because PLAN is a keyword in SQLite (EXPLAIN QUERY PLAN).
 */
const PLAN_COLUMNS = 'id, profile_id, goal, audience, "plan", created_at';

const SELECT_PLAN_BY_ID = `SELECT ${PLAN_COLUMNS} FROM research_plans WHERE id = ?`;
const SELECT_PLANS_FOR_PROFILE = `SELECT ${PLAN_COLUMNS} FROM research_plans WHERE profile_id = ? ORDER BY created_at DESC, id DESC`;
/**
 * Insert only when the profile exists, in one statement: zero rows inserted
 * means the profile is missing. One statement is atomic, so a concurrent
 * profile delete cannot slip between a check and the write, and the answer
 * does not depend on whether the connection enforces foreign keys.
 */
const INSERT_PLAN =
  'INSERT INTO research_plans (id, profile_id, goal, audience, "plan") SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM profiles WHERE id = ?)';
const DELETE_PLAN = 'DELETE FROM research_plans WHERE id = ?';

/**
 * The lookup behind {@link findPlanByFieldSet}, done in SQL so only the one
 * winning row crosses the wire.
 *
 * The requested names are bound as one JSON array. A plan qualifies when no
 * requested name is missing from its `$.fields[*].name` (`json_each` over
 * both), so its set covers the request — an exact match is the case where the
 * sizes are equal. Ordering by the number of planned fields puts the exact
 * match, else the smallest superset, first; `created_at` breaks ties in
 * favour of the newest plan. The size is the number of planned fields rather
 * than distinct names; a plan with a duplicate name is flagged by `planIssues`
 * at write time and is not worth a second pass here.
 */
const SELECT_PLAN_COVERING = `SELECT ${PLAN_COLUMNS} FROM research_plans AS p
  WHERE NOT EXISTS (
    SELECT 1 FROM json_each(?) AS wanted
    WHERE wanted.value NOT IN (
      SELECT json_extract(field.value, '$.name') FROM json_each(p."plan", '$.fields') AS field
    )
  )
  ORDER BY json_array_length(p."plan", '$.fields') ASC, created_at DESC, id DESC
  LIMIT 1`;

/**
 * A write named a profile that does not exist. Carries the id so the route can
 * answer 404 naming it.
 */
export class PlanProfileMissingError extends Error {
  readonly profileId: string;

  constructor(profileId: string) {
    super(`No profile with id ${profileId}`);
    this.name = 'PlanProfileMissingError';
    this.profileId = profileId;
  }
}

function toPlan(row: Row): SavedPlan {
  return parseJsonColumns(row, JSON_COLUMNS) as SavedPlan;
}

/** Read one saved plan. `null` when no row has that id. */
export async function getPlan(id: string): Promise<SavedPlan | null> {
  const [row] = await selectRows(SELECT_PLAN_BY_ID, [id]);
  return row ? toPlan(row) : null;
}

/** Every plan saved for a profile, newest first. */
export async function listPlans(profileId: string): Promise<SavedPlan[]> {
  return (await selectRows(SELECT_PLANS_FOR_PROFILE, [profileId])).map(toPlan);
}

/**
 * Save a plan under a profile.
 *
 * The id is generated here rather than by the database so the caller has it
 * without a second lookup. The plan is stored whole, as one JSON value: its
 * shape is the planner's to change, and a run reads it back as one unit.
 *
 * @throws {PlanProfileMissingError} when no profile has `profileId`.
 */
export async function savePlan(input: SavePlanInput): Promise<SavedPlan> {
  const { profileId, goal, audience, plan } = savePlanSchema.parse(input);
  const id = nanoid();

  const inserted = await (await appDb()).execute({
    sql: INSERT_PLAN,
    args: [id, profileId, goal, audience ?? null, toJsonColumn(plan), profileId],
  });
  if (inserted.rowsAffected === 0) throw new PlanProfileMissingError(profileId);

  // Read back rather than returning the input: `created_at` comes from the
  // database, and this proves the row is actually readable.
  const saved = await getPlan(id);
  if (!saved) throw new Error(`Plan ${id} was inserted but could not be read back`);

  return saved;
}

/**
 * Delete a saved plan. `false` when no row had that id.
 *
 * Only the plan row goes. Runs recorded in Dolt that followed it keep their
 * `plan_id`: a run is the record of what was found, and that record outlives
 * the plan.
 */
export async function deletePlan(id: string): Promise<boolean> {
  const deleted = await (await appDb()).execute({ sql: DELETE_PLAN, args: [id] });
  return deleted.rowsAffected > 0;
}

/**
 * The newest saved plan whose field-name set equals the requested set, or
 * failing that the smallest saved plan whose set is a superset of it. `null`
 * when no saved plan covers every requested name.
 *
 * Order-independent and duplicate-tolerant in the request, like the in-memory
 * cache key: the same fields in any order find the same plan. The returned
 * plan is the whole saved plan, not narrowed to the request; the caller
 * restricts it (`restrictPlan`) and keeps the full plan for later lookups.
 */
export async function findPlanByFieldSet(fieldNames: readonly string[]): Promise<SavedPlan | null> {
  const wanted = [...new Set(fieldNames)];
  if (wanted.length === 0) return null;

  const [row] = await selectRows(SELECT_PLAN_COVERING, [JSON.stringify(wanted)]);
  return row ? toPlan(row) : null;
}
