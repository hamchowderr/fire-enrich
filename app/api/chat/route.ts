import { NextRequest, NextResponse } from 'next/server';

import { gatewayConfigured } from '@/lib/gateway-auth';
import { mastra } from '@/lib/mastra';
import { chatContextMessage, type ChatTableContext } from '@/lib/mastra/agents/chat';

export const runtime = 'nodejs';

/** Steps the chat agent may take: a search, a scrape, and the answer, with room to retry one. */
const CHAT_MAX_STEPS = 6;

/** Search results announced as "Reading …" per search call. */
const READ_LINES_PER_SEARCH = 3;

// Store active queries
const activeQueries = new Map<string, AbortController>();

type HistoryTurn = { role: 'user'; content: string } | { role: 'assistant'; content: string };

interface ChatSource {
  url: string;
  title?: string;
}

interface SearchToolResult {
  results?: Array<{ url?: string; title?: string }>;
}

interface ScrapeToolResult {
  url?: string;
  title?: string;
  blocked?: boolean;
}

/** The panel's recent turns, kept to well-formed user and assistant messages. */
function historyMessages(history: unknown): HistoryTurn[] {
  if (!Array.isArray(history)) return [];

  return history.filter(
    (turn): turn is HistoryTurn =>
      (turn?.role === 'user' || turn?.role === 'assistant') &&
      typeof turn?.content === 'string' &&
      turn.content.trim().length > 0
  );
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export async function POST(request: NextRequest) {
  try {
    const { question, context, conversationHistory, sessionId } = await request.json();

    if (!question || !question.trim()) {
      return NextResponse.json(
        { error: 'Question is required' },
        { status: 400 }
      );
    }

    // API keys come from the environment only. They are injected from the
    // secrets manager at runtime and are never read from the request. The
    // agent's model and tools read them from the environment themselves. The
    // gateway's credential is its key or, on Vercel, the deployment's OIDC
    // token; `gatewayConfigured` checks both the way the gateway does.
    if (!gatewayConfigured() || !process.env.FIRECRAWL_API_KEY) {
      return NextResponse.json(
        { error: 'Missing API keys' },
        { status: 500 }
      );
    }

    // Create abort controller for this query
    const abortController = new AbortController();
    const queryId = sessionId || `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    activeQueries.set(queryId, abortController);

    const agent = mastra.getAgent('chat');
    const messages = [
      ...historyMessages(conversationHistory),
      { role: 'user' as const, content: chatContextMessage(question, (context ?? {}) as ChatTableContext) },
    ];

    // Create streaming response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const send = (data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };

        try {
          send({ type: 'status', message: 'Checking enriched table data...', step: 'table_check' });

          const output = await agent.stream(messages, {
            maxSteps: CHAT_MAX_STEPS,
            abortSignal: abortController.signal,
          });

          // Pages the agent scraped, in order. The answer cites the last one.
          // A search hit is never cited: the model may have answered from any
          // of the excerpts, so an answer without a scrape cites the table.
          const read: ChatSource[] = [];

          for await (const chunk of output.fullStream) {
            if (chunk.type === 'tool-call') {
              const args = (chunk.payload.args ?? {}) as { query?: string; url?: string };

              if (chunk.payload.toolName === 'search' && args.query) {
                send({ type: 'status', message: `Searching the web for "${args.query}"...`, step: 'search' });
              }
            } else if (chunk.type === 'tool-result') {
              if (chunk.payload.isError) continue;

              if (chunk.payload.toolName === 'search') {
                const results = ((chunk.payload.result ?? {}) as SearchToolResult).results ?? [];
                const found = results
                  .filter((result): result is ChatSource => typeof result.url === 'string' && result.url.length > 0)
                  .map(({ url, title }) => ({ url, title: title || undefined }));

                send({ type: 'status', message: `Found ${found.length} sources`, step: 'select' });
                for (const source of found.slice(0, READ_LINES_PER_SEARCH)) {
                  send({ type: 'status', message: `Reading ${source.url}`, step: 'scrape', source });
                }
              } else if (chunk.payload.toolName === 'scrape') {
                const result = (chunk.payload.result ?? {}) as ScrapeToolResult;
                if (!result.url || result.blocked) continue;

                const source = { url: result.url, title: result.title || undefined };
                send({ type: 'status', message: `Reading ${source.url}`, step: 'scrape', source });
                read.push(source);
              }
            } else if (chunk.type === 'error') {
              throw chunk.payload.error instanceof Error
                ? chunk.payload.error
                : new Error(String(chunk.payload.error ?? 'The chat agent failed'));
            }
          }

          // Stopped by DELETE: the panel has already moved on.
          if (abortController.signal.aborted) return;

          // The last step's text is the answer; earlier steps may carry a line
          // the model wrote before calling a tool.
          const steps = await output.steps;
          const answer = (steps.at(-1)?.text ?? (await output.text)).trim();
          const cited = read.at(-1);

          send({
            type: 'response',
            message: answer || "I couldn't find an answer to that. Could you rephrase your question?",
            source: cited
              ? { url: cited.url, title: cited.title ?? hostname(cited.url) }
              : { type: 'table', title: 'Enriched Data Table' },
          });
          send({ type: 'complete' });
        } catch (error) {
          if (abortController.signal.aborted) return;

          console.error('[Chat API] Error:', error);
          send({
            type: 'error',
            message: error instanceof Error ? error.message : 'An error occurred',
          });
        } finally {
          activeQueries.delete(queryId);
          closed = true;
          controller.close();
        }
      },
    });

    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error('[Chat API] Failed to process request:', error);
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    );
  }
}

// Stop endpoint
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const queryId = searchParams.get('queryId');

  if (!queryId) {
    return NextResponse.json(
      { error: 'Query ID required' },
      { status: 400 }
    );
  }

  const controller = activeQueries.get(queryId);
  if (controller) {
    controller.abort();
    activeQueries.delete(queryId);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json(
    { error: 'Query not found' },
    { status: 404 }
  );
}
