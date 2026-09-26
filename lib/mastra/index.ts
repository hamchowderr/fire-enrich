import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';

import { libsqlConnection } from '@/lib/libsql-url.mjs';

import { browserAgent } from './agents/browser';
import { chatAgent } from './agents/chat';
import { identifyAgent } from './agents/identify';
import { plannerAgent } from './agents/planner';
import { researchAgent } from './agents/research';
import { evidenceSupportClassifier } from './evidence-support';
import { configureAIMock } from './lib/aimock';
import { enrichRowWorkflow } from './workflows/enrich-row';

// Route OpenAI-compatible clients at AIMock when `USE_AIMOCK=true`. Runs before
// the Mastra instance is built and before anything else in this process reads
// `OPENAI_BASE_URL`. The agents imported above already resolve their model
// through `resolveModel()`, which points at AIMock explicitly, so import order
// cannot bypass the switch for them.
configureAIMock();

function createMastra() {
  return new Mastra({
    /**
     * LibSQL serves both deployment shapes from one adapter.
     *
     * With `TURSO_DATABASE_URL` set, this talks to Turso over the network, which
     * is what serverless needs: instances are ephemeral and share no disk.
     * With the variable unset, it falls back to a local SQLite file so a fresh
     * clone runs with no database to provision. `authToken` is undefined for the
     * file path, which the adapter accepts.
     *
     * The url comes from `lib/libsql-url.mjs`, which the app's own tables
     * (profiles and saved plans, `lib/app-db.ts`) read too: one database for
     * both. The local file is only resolved on the fallback path, so a
     * deployment using Turso never touches the filesystem.
     */
    storage: new LibSQLStore({ id: 'fire-enrich-storage', ...libsqlConnection() }),
    agents: {
      /**
       * Attached by the research agent as its `agent-browser` sub-agent tool,
       * for a group whose planned strategy is `browser` and only then.
       * Registered so Studio can drive it on its own.
       */
      browser: browserAgent,
      planner: plannerAgent,
      identify: identifyAgent,
      research: researchAgent,
      /** Answers the chat panel: from the enriched table, or from the web. */
      chat: chatAgent,
    },
    workflows: {
      enrichRow: enrichRowWorkflow,
    },
    /**
     * Asked by the research step whether a finding's quote supports its value,
     * when EVIDENCE_CHECK turns the check on. Registered so its evaluations are traced when
     * observability is configured (e.g. in Studio); this app configures none.
     */
    classifiers: {
      evidenceSupport: evidenceSupportClassifier,
    },
  });
}

type MastraInstance = ReturnType<typeof createMastra>;

/**
 * Cache the instance on `globalThis`.
 *
 * Turbopack re-evaluates route modules on edit, and each evaluation would
 * otherwise build a second Mastra instance holding a second LibSQL client. Two
 * clients on the same local SQLite file contend for the same write lock, and on
 * Turso they double the connection count. Caching outside the module registry
 * keeps exactly one instance per process.
 */
const globalForMastra = globalThis as typeof globalThis & {
  __fireEnrichMastra?: MastraInstance;
};

export const mastra: MastraInstance = (globalForMastra.__fireEnrichMastra ??= createMastra());
