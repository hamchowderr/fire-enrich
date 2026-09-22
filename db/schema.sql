-- Fire Enrich schema, applied by `npm run db:migrate` against a Dolt server.
--
-- Dolt speaks the MySQL wire protocol, so this is ordinary MySQL DDL. What Dolt
-- adds is that every applied change is a versioned commit: `dolt_log` shows when
-- the schema moved, `dolt_diff` shows what moved, and a bad migration can be
-- rolled back rather than hand-repaired.
--
-- Every statement is `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
-- so the whole file is safe to re-apply: the second run is a no-op and the
-- migration script makes no Dolt commit. The script splits this file on `;` at
-- end of line, so keep one statement per `;` and no `;` inside a literal.
--
-- Ids are application-generated (nanoid, 21 chars) rather than AUTO_INCREMENT:
-- rows are created by route handlers that need the id before the insert returns,
-- and a text id stays stable across a Dolt branch merge where two branches would
-- otherwise both claim the same integer.
--
-- The chain is: a profile describes a business → a research plan is made for that
-- profile → an enrichment run executes that plan over a contact list → each run
-- produces enrichments (one field value per contact) → each enrichment cites
-- evidence. Foreign keys are declared with ON DELETE CASCADE so deleting a
-- profile takes its whole subtree with it; Dolt enforces them like MySQL.

-- A business profile: who the business is, what it sells, who it sells to, and
-- the defaults the planner should assume when the operator does not say
-- otherwise. This is the first-class input the planner reads — not prompt text
-- pasted into a request.
CREATE TABLE IF NOT EXISTS profiles (
  -- nanoid; see the note above on why this is not AUTO_INCREMENT.
  id VARCHAR(32) NOT NULL,
  -- Operator-facing label, unique so two profiles cannot be confused in a picker.
  name VARCHAR(255) NOT NULL,
  -- Prose: what the business does. Read by the planner, so it is long-form text
  -- rather than a constrained column.
  business_summary TEXT NOT NULL,
  -- Prose: what the business actually sells, in its own words.
  offer TEXT NOT NULL,
  -- JSON array of strings: the audiences this business sells to.
  audiences JSON NOT NULL,
  -- JSON array of strings: default enrichment fields to look for, in operator
  -- language ("funding stage", "hiring for sales"). The planner turns these into
  -- a concrete plan; they are hints, not a schema.
  default_field_hints JSON NOT NULL,
  -- JSON object: CRM-side defaults (owner, pipeline, tags…). Shape is owned by
  -- the CRM integration, so this column stays an open object on purpose.
  crm_defaults JSON NOT NULL,
  -- JSON object keyed by model role (planner/research/chat) holding gateway model
  -- ids. Partial by design: a key that is absent falls back to DEFAULT_MODEL_IDS
  -- in lib/mastra/models.ts, so a profile only records where it disagrees with
  -- the code default.
  models JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_profiles_name (name)
);

-- Indexed because the profile list is sorted newest-first.
CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON profiles (created_at);

-- A research plan the planner produced for one profile: the goal and audience it
-- was asked about, and the plan itself.
CREATE TABLE IF NOT EXISTS research_plans (
  id VARCHAR(32) NOT NULL,
  profile_id VARCHAR(32) NOT NULL,
  -- What the operator asked for in their own words.
  goal TEXT NOT NULL,
  -- Which of the profile's audiences this plan targets. Nullable: a plan may be
  -- audience-agnostic.
  audience VARCHAR(255) NULL,
  -- JSON object: the planner's output (fields to resolve, strategies, order).
  -- Shape is owned by the planner and will change as it improves, so the column
  -- stays an open object rather than a set of columns that would need a
  -- migration per planner revision.
  -- Backticked because `plan` is a reserved word in Dolt's parser; it is the
  -- only identifier in this file that needs quoting.
  `plan` JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_research_plans_profile
    FOREIGN KEY (profile_id) REFERENCES profiles (id) ON DELETE CASCADE
);

-- Lookup column: "every plan for this profile".
CREATE INDEX IF NOT EXISTS idx_research_plans_profile_id ON research_plans (profile_id);
CREATE INDEX IF NOT EXISTS idx_research_plans_created_at ON research_plans (created_at);

-- One execution of a plan over one contact list.
CREATE TABLE IF NOT EXISTS enrichment_runs (
  id VARCHAR(32) NOT NULL,
  plan_id VARCHAR(32) NOT NULL,
  -- How to find the input list (an uploaded CSV name, a stored list id). Kept as
  -- an opaque reference so the run row does not depend on where lists live.
  list_ref VARCHAR(512) NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL until the run stops, for any reason.
  finished_at DATETIME NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  -- The Dolt commit this run's enrichments landed in, so a result set can be
  -- read back exactly as it was written (`AS OF <hash>`). NULL until committed.
  commit_hash VARCHAR(64) NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_enrichment_runs_plan
    FOREIGN KEY (plan_id) REFERENCES research_plans (id) ON DELETE CASCADE
);

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
