/**
 * The browser agent's model call, answered by AIMock (`fixtures/browser-page.json`).
 *
 * The agent is driven the way the research agent's `agent-browser` sub-agent
 * tool drives it: one prompt, with the memory thread and resource its
 * browser-context processor requires. The fixture answers with text and no
 * tool call, so no page is opened and the hosted Firecrawl session is never
 * provisioned; the browser stays unlaunched from start to end and the only
 * request leaves for AIMock. A pass proves the prompt reached the mock with
 * the browser tools and `scrape` attached, and that the fixture matched on
 * the agent's own instructions.
 *
 * Requires AIMock on `AIMOCK_URL` (`npm run test:ai` starts it).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { mastra } from '@/lib/mastra';

import browserFixtures from '../../fixtures/browser-page.json';

const AIMOCK_URL = process.env.AIMOCK_URL as string;

const [fixture] = browserFixtures.fixtures;
const PROMPT = fixture.match.userMessage;
const ANSWER = fixture.response.content;

/** The tools the request carried, by name, for the request holding `PROMPT`. */
async function toolsSentWithPrompt(): Promise<string[]> {
  const response = await fetch(`${AIMOCK_URL}/__aimock/journal?path=/v1/chat/completions`);
  const entries = (await response.json()) as unknown;
  if (!Array.isArray(entries)) return [];

  const entry = (entries as Array<{ body?: { messages?: unknown; tools?: Array<{ function?: { name?: string } }> } }>)
    .reverse()
    .find((candidate) => JSON.stringify(candidate.body?.messages).includes(PROMPT));

  return (entry?.body?.tools ?? []).map((tool) => tool.function?.name ?? '').sort();
}

beforeAll(async () => {
  const health = await fetch(`${AIMOCK_URL}/health`).catch(() => undefined);
  if (!health?.ok) throw new Error(`AIMock is not reachable at ${AIMOCK_URL}.`);
});

describe('browser agent', () => {
  it('answers from the fixture, with the browser tools offered and no session opened', async () => {
    const agent = mastra.getAgent('browser');

    const result = await agent.generate(PROMPT, {
      memory: { thread: 'browser-fixture-thread', resource: 'browser-fixture' },
    });

    expect(result.text).toBe(ANSWER);
    expect(agent.browser?.isBrowserRunning()).toBe(false);

    const tools = await toolsSentWithPrompt();
    expect(tools).toContain('scrape');
    expect(tools).toEqual(
      expect.arrayContaining(['browser_goto', 'browser_snapshot', 'browser_click', 'browser_close'])
    );
  }, 60_000);
});
