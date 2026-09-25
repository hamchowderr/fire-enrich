# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Branches

- `main` is the product. Pull requests target `main`.
- Production deploys from `main`: every merge to `main` deploys production and runs the database migration (see below).
- `upstream-main` mirrors `firecrawl/fire-enrich` main. Branch from it for changes meant for upstream.
- Work happens on `feature/`, `fix/` and `chore/` branches.

## Build & Test

```bash
npm run check          # check:lockfile + typecheck + lint + lint:mastra + fallow:gate, in order; what CI runs
npm run check:lockfile # fails if an @next/swc-* binary next declares is missing at the top level, at another version, or nested under next
npm run typecheck      # tsc --noEmit (includes tests/)
npm run lint           # next lint
npm run lint:mastra    # mastra lint on lib/mastra (--strict: warnings fail)
npm run fallow:gate    # dead-code gate: fails on any finding not in fallow.baseline.json
npm run test:ai        # starts AIMock on :4010, runs vitest, stops it
npm test               # vitest only; tests/routes/* need `npm run aimock` running
npm run build          # next build
npm run build:vercel   # Vercel's build: next build, then db:migrate on production (see below)
npm run test:e2e       # Playwright smoke against the built app; CI runs it after the build with E2E_SKIP_BUILD=1
npm run db:sweep-runs  # merge run/* branches idle over 6h into main (partial, or failed if given up); -- --older-than-hours N, -- --dry-run
npm run db:migrate     # apply db/schema.sql to the DOLT_* database; a re-run is a no-op with no commit
```

### Database migrations

Vercel builds with `npm run build:vercel` (`buildCommand` in `vercel.json`, which runs `scripts/vercel-build.mjs`):
`npm run build`, then `db:migrate` against that deployment's `DOLT_*` database.
It migrates only when `VERCEL_ENV=production`, or on Preview when
`DOLT_PREVIEW_MIGRATE=1` is set there. Set that flag only when Preview's `DOLT_*`
point at a database no production deploy uses. A failed migration fails the
deployment. Local `npm run build` is plain `next build` and needs no database.

The migration runs while the previous deployment still serves traffic, and an
instant rollback puts old code on the new schema. So every change to
`db/schema.sql` must be additive and backwards-compatible: add tables, nullable
columns, columns with defaults, and non-unique indexes. A UNIQUE constraint or
index is not additive-safe: it fails on existing duplicates and rejects writes
that old code still makes. Never drop or rename a column or
table, or tighten a constraint, in the same release as the code that stops
using it. Do that in a later release, after no live deployment reads it. Every
statement must stay re-runnable (see the header of `db/schema.sql`).

CI's `migrate` job applies the base branch's schema to a throwaway
`dolthub/dolt-sql-server` container, then runs `tests/dolt/migrate.live.test.ts`.
That test migrates, checks that a second run commits nothing, and compares the
result with a fresh database. It is skipped unless `DOLT_TEST_HOST` and
`DOLT_TEST_DATABASE` are set. Never point them at a database whose data matters.

Dolt is pinned to `dolthub/dolt-sql-server:2.3.1` on both the hosted server
(its Coolify service compose) and CI's `migrate` job. Server and CI must be
bumped together, to the same exact tag. Never pin the server lower than the
version it runs: an older Dolt can misread newer storage formats.

Apart from that opt-in migration test, tests never touch a real model, Firecrawl, or database: `tests/setup.ts` forces
`USE_AIMOCK=true` (model calls answered from `fixtures/*.json`), stub API keys, and a
temp SQLite file. Firecrawl is mocked at the SDK boundary from the recordings in
`tests/fixtures/firecrawl/`. Every new engine feature ships tests on this harness.

After deliberately removing dead code, refresh the gate with `npm run fallow:baseline`
and commit `fallow.baseline.json`; never add entries to it by hand to get a PR green.

## Architecture Overview

`POST /api/enrich` runs the `enrichRow` workflow (`lib/mastra/workflows/enrich-row.ts`) per row through `lib/mastra/enrich-adapter.ts`. `POST /api/chat` streams the `chat` agent (`lib/mastra/agents/chat.ts`), which answers from the enriched table or searches the web with the Firecrawl tools.

### Evidence-support check (off by default)

`EVIDENCE_CHECK=1` turns on a second check in the research step, after `checkFindings`: the
`evidence-support` Classifier (`lib/mastra/evidence-support.ts`, model `typesafe-ai/jev` on the
AI Gateway, registered on the Mastra instance) asks whether each finding's quote supports its value,
one call per finding, in parallel. A finding below `EVIDENCE_CHECK_THRESHOLD` (default `0.5`) is
withdrawn the same way `checkFindings` withdraws one with no read evidence, so it shows as unknown.
Both are read from `process.env` on every row. The check fails open: an error or a call over 3 s
keeps the finding and logs one `[EVIDENCE]` warning per group. A cancelled run makes no more calls.
AIMock cannot serve evaluation models, so tests use a hand-written `Experimental_EvaluationModelV4`
(`tests/unit/evidence-support.test.ts`) or spy on the registered classifier's model. The AI SDK
evaluation API is experimental.

## Conventions & Patterns

- The Fire Enrich Board artifact is built and republished by the braynee `board` skill (`/braynee:board`); the repo has no board script of its own.
