/**
 * Tier 3 of the retrieval capability: a page that has to be driven.
 *
 * Some facts are behind an interaction rather than behind a url — a pricing
 * table that only renders after a plan toggle, a directory that paginates with
 * a button, a spec that appears in a tab. Neither a scrape nor the hosted
 * research agent can reach those, because both read what the server sends.
 * This agent gets a real browser.
 *
 * It is registered on the Mastra instance so the research agent can attach it
 * as a sub-agent tool — but only for a group whose planned strategy is
 * `browser`. Driving a browser costs a hosted session and many model turns, so
 * it is the tier of last resort, never the default.
 *
 * ## Entitlement
 *
 * The browser makes it *possible* to get past a login, a paywall or a bot
 * check. That it is possible is exactly why the rule has to be written down:
 * this agent reads only what the owner of the run is entitled to read, and a
 * page it cannot reach resolves as unknown, with the reason attached, rather
 * than as a puzzle to be solved. The instructions below say so to the model;
 * this comment says so to the next person who edits them.
 *
 * ## Configuration
 *
 * `FirecrawlBrowser` provisions hosted Chrome sessions through the Firecrawl
 * API and drives them with the deterministic `@mastra/agent-browser` toolset,
 * so nothing has to run a browser locally — which is what makes this work on a
 * serverless deployment at all. `scope: 'shared'` gives the whole process one
 * session instead of one per thread: a session is a billed sandbox, and
 * enrichment drives a handful of pages in sequence rather than many at once.
 * `@mastra/browser-firecrawl` reads `FIRECRAWL_API_KEY` from the environment
 * and throws at construction when it is missing, which is deliberate — a
 * process that cannot reach Firecrawl cannot enrich anything, so it should fail
 * at boot rather than on the first row.
 */
import { FirecrawlBrowser } from '@mastra/browser-firecrawl';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';

import { resolveModel } from '../models';
import { scrapeTool } from '../tools/firecrawl';
import { BLOCKED_DOMAINS_LABEL } from '../tools/filters';

export const browserAgent = new Agent({
  id: 'browser',
  name: 'Browser',
  description:
    'Drives a hosted browser to read a page that only reveals the answer after interaction — a toggle, a tab, a pagination control. Use only when scraping the url returns nothing useful.',
  instructions: [
    'You read web pages that will not give up their content to a plain fetch, and you report one fact at a time.',
    '',
    'How to work:',
    '- Start from the url you were given. Use the browser tools to open it, and read the page before acting on it.',
    '- Interact only as far as the fact requires: open the tab, toggle the control, turn the page. Then read.',
    '- Prefer firecrawl-scrape when the page turns out to be static after all. It is faster and cheaper than driving the browser.',
    '- Report the value you found and the url it was on. If the page shows a different value than you expected, report what the page says.',
    '',
    'What you must not do:',
    '- Use only sources the owner of this run is entitled to use. If you were not given access to something, you do not have it.',
    '- Never bypass an access control. Do not log in, do not create an account, do not enter credentials, do not accept an invitation, do not defeat a bot check or captcha, do not evade a paywall or a rate limit, do not edit the page or its requests to reveal content the site withheld.',
    `- Never visit ${BLOCKED_DOMAINS_LABEL}. Those sites are out of scope for this pipeline.`,
    '',
    'When a page is blocked:',
    '- A login wall, a paywall, a captcha, a bot check, a geo block or a blocked domain all have the same answer: stop.',
    '- Report the value as unknown and say precisely why — which url, and which barrier. "Unknown: docs.example.com/pricing requires a signed-in account" is a correct and useful answer.',
    '- An honest unknown is worth more than a value obtained by getting around a control. Never guess a value to avoid reporting unknown.',
  ].join('\n'),
  model: resolveModel('research'),
  browser: new FirecrawlBrowser({ scope: 'shared' }),
  /**
   * Required, not optional, for this agent.
   *
   * Configuring a browser injects Mastra's `browser-context` processor, which
   * tracks where the browser is between steps and refuses to run without
   * memory: "computeStateSignal requires Mastra memory with an active
   * resourceId and threadId". No config is passed because the default resolves
   * storage from the Mastra instance, which is the same LibSQL store
   * everything else in this app uses.
   *
   * A caller must therefore supply a thread and a resource — `{ memory: {
   * thread, resource } }` on a generate call. Without them the processor logs
   * that it skipped and the browser loses its place between steps.
   */
  memory: new Memory(),
  tools: { scrape: scrapeTool },
});
