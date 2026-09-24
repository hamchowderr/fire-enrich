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


## Build & Test

```bash
npm run check          # check:lockfile + typecheck + lint + lint:mastra + fallow:gate, in order; what CI runs
npm run check:lockfile # fails if package-lock.json lacks an @next/swc-* binary next build would patch in
npm run typecheck      # tsc --noEmit (includes tests/)
npm run lint           # next lint
npm run lint:mastra    # mastra lint on lib/mastra (--strict: warnings fail)
npm run fallow:gate    # dead-code gate: fails on any finding not in fallow.baseline.json
npm run test:ai        # starts AIMock on :4010, runs vitest, stops it
npm test               # vitest only; tests/routes/* need `npm run aimock` running
npm run build          # next build
npm run test:e2e       # Playwright smoke against the built app; CI runs it after the build with E2E_SKIP_BUILD=1
```

Tests never touch a real model, Firecrawl, or database: `tests/setup.ts` forces
`USE_AIMOCK=true` (model calls answered from `fixtures/*.json`), stub API keys, and a
temp SQLite file. Firecrawl is mocked at the SDK boundary from the recordings in
`tests/fixtures/firecrawl/`. Every new engine feature ships tests on this harness.

After deliberately removing dead code, refresh the gate with `npm run fallow:baseline`
and commit `fallow.baseline.json`; never add entries to it by hand to get a PR green.

## Architecture Overview

`POST /api/enrich` runs the `enrichRow` workflow (`lib/mastra/workflows/enrich-row.ts`) per row through `lib/mastra/enrich-adapter.ts`. `POST /api/chat` streams the `chat` agent (`lib/mastra/agents/chat.ts`), which answers from the enriched table or searches the web with the Firecrawl tools.

## Conventions & Patterns

- The Fire Enrich Board artifact is built and republished by the braynee `board` skill (`/braynee:board`); the repo has no board script of its own.
