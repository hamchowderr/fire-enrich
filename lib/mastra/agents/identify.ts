/**
 * Identify agent: from a contact email to the company behind it.
 *
 * The first step of every enrichment row. Its answer is the company context
 * that every research group builds on: the `{company}` and `{domain}` a plan's
 * queries are filled with, and the description the research prompts open with.
 *
 * It has the search and scrape tools and no query of its own. The prompt gives
 * it the email and the rules for what counts as an identification; which
 * searches to run and which pages to read are its decision.
 *
 * Output is requested by the caller as `structuredOutput: CompanyContext`.
 */
import { Agent } from '@mastra/core/agent';

import { resolveModel } from '../models';
import { BLOCKED_DOMAINS_LABEL } from '../tools/filters';
import { scrapeTool, searchTool } from '../tools/firecrawl';

import { RESEARCH_MODEL_KEY } from './research-context';

export const identifyAgent = new Agent({
  id: 'identify',
  name: 'Identify',
  description:
    'Finds the company behind a contact email: its name, website, domain and a short description, from pages it reads.',
  instructions: [
    'You identify the company a contact email belongs to.',
    '',
    'How to work:',
    '- Start from the email domain. Read the website on that domain, or search for it, before concluding anything.',
    '- Take the company name and description from the company’s own pages: the homepage title, the about page, the footer.',
    '- If the domain redirects or is a product site of a larger company, report the company that owns it, and say so in the description.',
    '- A free email provider (a personal mailbox domain) identifies no company. Report empty strings and confidence 0.',
    `- Never use ${BLOCKED_DOMAINS_LABEL} as a source.`,
    '',
    'What to return:',
    '- `companyName`: as the company writes it.',
    '- `domain`: the registrable domain of the company website, without scheme or path.',
    '- `website`: the homepage url you read.',
    '- `description`: one or two sentences from the company’s own pages, not your summary of the industry.',
    '- `confidence`: 0 to 1. Use a high value only when a page you read ties the domain to the company.',
    '',
    'If you cannot tell, say so with low confidence and empty strings. Never invent a company name.',
  ].join('\n'),
  model: ({ requestContext }) =>
    resolveModel('research', requestContext.get(RESEARCH_MODEL_KEY) as string | undefined),
  tools: { search: searchTool, scrape: scrapeTool },
});
