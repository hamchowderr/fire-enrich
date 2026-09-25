-- Fire Enrich schema, applied by `npm run db:migrate` against a Dolt server.
--
-- Dolt speaks the MySQL wire protocol, so this is ordinary MySQL DDL. What Dolt
-- adds is that every applied change is a versioned commit: `dolt_log` shows when
-- the schema moved, `dolt_diff` shows what moved, and a bad migration can be
-- rolled back rather than hand-repaired.
--
-- Every statement is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
-- (or, for a change to an existing table, a conditional block that reads
-- `information_schema` first) so the whole file is safe to re-apply: the second
-- run is a no-op and the migration script makes no Dolt commit. The script
-- splits this file on `;` at end of line, so keep one statement per `;` and no
-- `;` inside a literal.
--
-- Ids are application-generated (nanoid, 21 chars) rather than AUTO_INCREMENT:
-- rows are created by route handlers that need the id before the insert returns,
-- and a text id stays stable across a Dolt branch merge where two branches would
-- otherwise both claim the same integer.
--
-- This database holds the versioned run history and nothing else: an
-- enrichment run over a contact list → its enrichments (one field value per
-- contact) → the evidence each enrichment cites. Foreign keys are declared
-- with ON DELETE CASCADE down that chain; Dolt enforces them like MySQL.
--
-- Business profiles and saved research plans live in the app's libSQL
-- database (Turso, or the local file), not here: see `lib/app-db-schema.mjs`.
-- A run names the plan it followed by `plan_id`, a plain value with no
-- foreign key, because the plan row is in the other database.
--
-- A database created before that move still holds `profiles` and
-- `research_plans` tables. This file leaves them as they are: nothing reads
-- or writes them any more, and dropping a table in the release that stops
-- using it would break the previous deployment, which still serves traffic
-- while this migration runs (see "Database migrations" in CLAUDE.md). Drop
-- them by hand, or in a later release, once no deployment older than the move
-- is live. The one change made to them is indirect: the foreign key from
-- `enrichment_runs` to `research_plans` is dropped below.

-- One execution of a plan over one contact list.
CREATE TABLE IF NOT EXISTS enrichment_runs (
  id VARCHAR(32) NOT NULL,
  -- The id of the saved plan the run followed, in the app's libSQL database
  -- (`research_plans`). A plain value: no foreign key can cross databases, so
  -- a run keeps the id of a plan deleted later, and the run and its
  -- enrichments stay the record of what was found. NULL for a plan that was
  -- never saved (one the planner wrote for a hand-typed field set and that
  -- only lived in the process cache).
  plan_id VARCHAR(32) NULL,
  -- How to find the input list (an uploaded CSV name, a stored list id). Kept as
  -- an opaque reference so the run row does not depend on where lists live.
  list_ref VARCHAR(512) NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL until the run stops, for any reason.
  finished_at DATETIME NULL,
  -- The run's heartbeat: set at start, moved on by the rows it records and by
  -- its finish, on the server's clock like the two columns above. The run
  -- sweeper (`npm run db:sweep-runs`) takes a branch as abandoned only when
  -- this has not moved for hours. NULL on runs recorded before the column
  -- existed.
  last_activity_at DATETIME NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  -- The Dolt commit this run's enrichments landed in, so a result set can be
  -- read back exactly as it was written (`AS OF <hash>`). NULL until committed.
  commit_hash VARCHAR(64) NULL,
  PRIMARY KEY (id)
);

-- Migration for a database created while profiles and plans were in Dolt,
-- when `enrichment_runs.plan_id` referenced `research_plans` through
-- `fk_enrichment_runs_plan` (ON DELETE CASCADE in the oldest databases, ON
-- DELETE SET NULL later). Saved plans now live in libSQL, so that key would
-- reject every run of a saved plan; it is dropped whatever its rule. `plan_id`
-- keeps its index, `idx_enrichment_runs_plan_id` below. Relaxing a constraint
-- is backwards-compatible: the previous deployment's writes still succeed.
--
-- Dolt (2.3) has no `DROP FOREIGN KEY IF EXISTS`, so the choice is made by
-- reading `information_schema` and executing the resulting statement as a
-- prepared one: the drop runs only while the constraint exists, and on a
-- fresh or already migrated database it is `SELECT 1` and `dolt_status`
-- stays clean. `@fe_*` names are session variables; the migration script runs
-- the whole file on one connection, so they survive from SET to PREPARE.
-- MODIFY to the same definition is a no-op; it stays for a database from
-- before `plan_id` was nullable.
SET @fe_drop_runs_fk = (SELECT IF(COUNT(*) > 0, 'ALTER TABLE enrichment_runs DROP FOREIGN KEY fk_enrichment_runs_plan', 'SELECT 1') FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND CONSTRAINT_NAME = 'fk_enrichment_runs_plan');
PREPARE fe_drop_runs_fk FROM @fe_drop_runs_fk;
EXECUTE fe_drop_runs_fk;
DEALLOCATE PREPARE fe_drop_runs_fk;
ALTER TABLE enrichment_runs MODIFY plan_id VARCHAR(32) NULL;

-- Migration for a database created before `last_activity_at`. Dolt (2.1) has
-- no `ADD COLUMN IF NOT EXISTS`, so, as above, `information_schema` decides:
-- the ALTER runs only while the column is missing, and existing runs get NULL,
-- which the sweeper reads as "no heartbeat recorded". On a fresh or already
-- migrated database it is `SELECT 1` and `dolt_status` stays clean.
SET @fe_add_runs_activity = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE enrichment_runs ADD COLUMN last_activity_at DATETIME NULL AFTER finished_at', 'SELECT 1') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'enrichment_runs' AND COLUMN_NAME = 'last_activity_at');
PREPARE fe_add_runs_activity FROM @fe_add_runs_activity;
EXECUTE fe_add_runs_activity;
DEALLOCATE PREPARE fe_add_runs_activity;

CREATE INDEX IF NOT EXISTS idx_enrichment_runs_plan_id ON enrichment_runs (plan_id);
-- The operator view is "runs still going" and "runs newest first".
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_status ON enrichment_runs (status);
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_started_at ON enrichment_runs (started_at);

-- One resolved field for one contact in one run. The grain is deliberately one
-- row per field rather than one row per contact: fields are added between runs,
-- and each field carries its own confidence and strategy.
CREATE TABLE IF NOT EXISTS enrichments (
  id VARCHAR(32) NOT NULL,
  run_id VARCHAR(32) NOT NULL,
  -- The contact this value is about. Email is the join key the enrichment
  -- pipeline already keys on.
  contact_email VARCHAR(320) NOT NULL,
  -- Field name as the plan named it.
  field VARCHAR(128) NOT NULL,
  -- The resolved value as text. NULL means "looked, found nothing", which is a
  -- different answer from no row at all ("never looked").
  value TEXT NULL,
  -- 0..1. DECIMAL, not FLOAT: these are compared and filtered on, and binary
  -- floats make `confidence >= 0.8` depend on representation.
  confidence DECIMAL(4, 3) NULL,
  -- Which strategy produced the value (search, scrape, inference…), so a bad
  -- field can be traced to the step that produced it.
  strategy VARCHAR(64) NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_enrichments_run
    FOREIGN KEY (run_id) REFERENCES enrichment_runs (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_enrichments_run_id ON enrichments (run_id);
-- The result table reads "every field for this contact in this run" in one go.
CREATE INDEX IF NOT EXISTS idx_enrichments_run_contact ON enrichments (run_id, contact_email);
CREATE INDEX IF NOT EXISTS idx_enrichments_contact_email ON enrichments (contact_email);

-- What an enrichment was based on. Several rows per enrichment is normal: a
-- value supported by three sources is more trustworthy than one supported by one,
-- and the UI shows the quotes.
CREATE TABLE IF NOT EXISTS evidence (
  id VARCHAR(32) NOT NULL,
  enrichment_id VARCHAR(32) NOT NULL,
  url VARCHAR(2048) NOT NULL,
  -- The passage that supports the value, so a reviewer can judge it without
  -- refetching the page (which may have changed).
  quote TEXT NULL,
  confidence DECIMAL(4, 3) NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_evidence_enrichment
    FOREIGN KEY (enrichment_id) REFERENCES enrichments (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_evidence_enrichment_id ON evidence (enrichment_id);
