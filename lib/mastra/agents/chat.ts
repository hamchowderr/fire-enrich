/**
 * Chat agent: answers the chat panel's questions about an enriched table.
 *
 * It answers from the table when the table holds the answer, and otherwise
 * searches the web and reads a page with the Firecrawl search and scrape tools.
 * The table is not in the instructions: it changes with every request, so the
 * route renders it into the user message with {@link chatContextMessage}.
 *
 * It has no memory. The panel sends its recent turns with each question and no
 * thread id, so the route passes those turns as prior messages instead.
 */
import { Agent } from '@mastra/core/agent';

import { resolveModel } from '../models';
import { BLOCKED_DOMAINS_LABEL } from '../tools/filters';
import { scrapeTool, searchTool } from '../tools/firecrawl';

export const chatAgent = new Agent({
  id: 'chat',
  name: 'Chat',
  description:
    'Answers questions about an enriched data table, from the table when it holds the answer and from the web when it does not.',
  instructions: [
    'You answer questions about a data-enrichment table. The user message holds the table (one line per enriched row) and then the question.',
    '',
    'How to work:',
    '- If the table answers the question, answer from it and call no tool.',
    '- Otherwise use `search` to find the page that answers it. Search results carry a trimmed excerpt of each page; when the excerpt does not state the answer outright, `scrape` the most relevant result and answer from the full page.',
    `- Never use ${BLOCKED_DOMAINS_LABEL} as a source.`,
    '',
    'How to answer:',
    '- Reply with the answer only; do not describe the searches you are about to run.',
    '- Two to four sentences of plain text: no markdown, no headings, no bold.',
    '- State facts only from the table or from pages a tool returned in this task. When neither has the answer, say so.',
  ].join('\n'),
  model: () => resolveModel('chat'),
  tools: { search: searchTool, scrape: scrapeTool },
});

/** What the panel sends as `context` with each question. */
export interface ChatTableContext {
  fields?: Array<{ name: string; displayName?: string }>;
  totalRows?: number;
  processedRows?: number;
  /** One line per enriched row, formatted by the panel. */
  tableData?: string;
}

/** Render the table context and the question into the user message. */
export function chatContextMessage(question: string, context: ChatTableContext = {}): string {
  const fields = (context.fields ?? []).map((field) => field.displayName || field.name).join(', ');
  const table = context.tableData?.trim() || 'No rows have been enriched yet.';

  return [
    'Enriched table',
    `Fields: ${fields || 'none'}`,
    `Rows: ${context.processedRows ?? 0} processed of ${context.totalRows ?? 0}`,
    '',
    table,
    '',
    `Question: ${question.trim()}`,
  ].join('\n');
}
