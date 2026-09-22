import { Agent } from '@mastra/core/agent';

import { resolveModel } from '../models';

/**
 * TEMPORARY smoke-test agent.
 *
 * It exists only so the Mastra instance has a registered agent to prove the
 * install works end to end: Studio lists it, generating from it exercises the
 * Vercel AI Gateway credential path, and the storage adapter gets initialised.
 * It has no tools and no memory on purpose.
 *
 * DELETE THIS FILE when the real planner agent lands, and drop `smoke` from the
 * `agents` map in `lib/mastra/index.ts` at the same time.
 */
export const smokeAgent = new Agent({
  id: 'smoke',
  name: 'Smoke',
  description: 'Temporary echo agent used to verify the Mastra install.',
  instructions: [
    'You are a smoke test. You exist only to prove the model path works.',
    'Echo the user message back verbatim on a single line, then stop.',
    'Do not add commentary, greetings, or explanation.',
  ].join('\n'),
  model: resolveModel('chat'),
});
