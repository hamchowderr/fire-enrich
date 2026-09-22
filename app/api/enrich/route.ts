import { NextRequest, NextResponse } from 'next/server';
import { AgentEnrichmentStrategy } from '@/lib/strategies/agent-enrichment-strategy';
import type { EnrichmentRequest, RowEnrichmentResult } from '@/lib/types';
import { loadSkipList, shouldSkipEmail, getSkipReason } from '@/lib/utils/skip-list';
import { ENRICHMENT_CONFIG } from '@/lib/config/enrichment';
import {
  enrichRowWithMastra,
  resolveSessionPlan,
  type CancellableRun,
} from '@/lib/mastra/enrich-adapter';

// Use Node.js runtime for better compatibility
export const runtime = 'nodejs';

/**
 * A running session: the controller that stops new rows from starting, and
 * the Mastra runs still in flight, so a DELETE can cancel them as well.
 */
interface ActiveSession {
  controller: AbortController;
  runs: Set<CancellableRun>;
}

// Store active sessions in memory (in production, use Redis or similar)
const activeSessions = new Map<string, ActiveSession>();

/**
 * Which pipeline enriches rows. `mastra` runs the enrichRow workflow through
 * `lib/mastra/enrich-adapter.ts`; anything else keeps the legacy strategy.
 * Read per request so a restart is not needed to switch.
 */
function mastraEngineSelected(): boolean {
  return process.env.ENRICH_ENGINE === 'mastra';
}

export async function POST(request: NextRequest) {
  try {
    // Add request body size check
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > 5 * 1024 * 1024) { // 5MB limit
      return NextResponse.json(
        { error: 'Request body too large' },
        { status: 413 }
      );
    }

    const body: EnrichmentRequest = await request.json();
    const { rows, fields, emailColumn, nameColumn } = body;

    if (!rows || rows.length === 0) {
      return NextResponse.json(
        { error: 'No rows provided' },
        { status: 400 }
      );
    }

    if (!fields || fields.length === 0 || fields.length > 10) {
      return NextResponse.json(
        { error: 'Please provide 1-10 fields to enrich' },
        { status: 400 }
      );
    }

    if (!emailColumn) {
      return NextResponse.json(
        { error: 'Email column is required' },
        { status: 400 }
      );
    }

    // API keys come from the environment only. They are injected from the
    // secrets manager at runtime and are never read from the request.
    const gatewayApiKey = process.env.AI_GATEWAY_API_KEY;
    const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;

    if (!gatewayApiKey || !firecrawlApiKey) {
      console.error('Missing API keys:', {
        hasGateway: !!gatewayApiKey,
        hasFirecrawl: !!firecrawlApiKey,
      });
      return NextResponse.json(
        { error: 'Server configuration error: Missing API keys' },
        { status: 500 }
      );
    }

    // Use a more compatible UUID generation
    const sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const abortController = new AbortController();
    const session: ActiveSession = { controller: abortController, runs: new Set() };
    activeSessions.set(sessionId, session);

    const mastraEngine = mastraEngineSelected();
    const strategyName = mastraEngine ? 'MastraEnrichRowWorkflow' : 'AgentEnrichmentStrategy';

    console.log(`[STRATEGY] Using ${strategyName}`);
    // Built for both engines (construction makes no calls); only the legacy
    // path uses it.
    const enrichmentStrategy = new AgentEnrichmentStrategy(gatewayApiKey, firecrawlApiKey);

    // Load skip list
    const skipList = await loadSkipList();

    // Create a streaming response
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // Rows still in flight after a cancel can finish a moment later; once
        // the stream is closed their writes are dropped instead of throwing.
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
          // Send session ID
          send({ type: 'session', sessionId });

          // Process rows with rolling concurrency (as each finishes, start the next)
          const concurrency = mastraEngine
            ? ENRICHMENT_CONFIG.MASTRA_CONCURRENT_ROWS
            : ENRICHMENT_CONFIG.CONCURRENT_ROWS;
          console.log(`[ENRICHMENT] Processing ${rows.length} rows with rolling concurrency: ${concurrency}`);

          // Send pending status for all rows
          for (let i = 0; i < rows.length; i++) {
            send({ type: 'pending', rowIndex: i, totalRows: rows.length });
          }

          // The Mastra engine resolves the plan once for the whole session —
          // the cached plan behind these fields, or one from the planner — and
          // passes it to every row, so a cold cache costs one planner call, not
          // one per concurrent row. Resolved after `pending` so the table fills
          // while a miss is being planned.
          const mastraPlan = mastraEngine
            ? await resolveSessionPlan(fields, abortController.signal)
            : null;

          const progress =
            (rowIndex: number) =>
            (message: string, type: 'info' | 'success' | 'warning' | 'agent', sourceUrl?: string) =>
              send({
                type: 'agent_progress',
                rowIndex,
                message,
                messageType: type,
                sourceUrl, // Include sourceUrl for favicons
              });

          // Process rows with rolling concurrency
          const processRow = async (i: number) => {
            // Check if cancelled
            if (abortController.signal.aborted) {
              return;
            }

            const row = rows[i];
            const email = row[emailColumn];

            // Add name to row context if nameColumn is provided
            if (nameColumn && row[nameColumn]) {
              row._name = row[nameColumn];
            }

            // Check if email should be skipped
            if (email && shouldSkipEmail(email, skipList)) {
              const skipReason = getSkipReason(email, skipList);

              // Send skip result
              const skipResult: RowEnrichmentResult = {
                rowIndex: i,
                originalData: row,
                enrichments: {},
                status: 'skipped',
                error: skipReason,
              };

              send({ type: 'result', result: skipResult });
              return;
            }

            // Send processing status
            send({ type: 'processing', rowIndex: i, totalRows: rows.length });

            try {
              // Enrich the row
              console.log(`[ENRICHMENT] Processing row ${i + 1}/${rows.length} - Email: ${email} - Strategy: ${strategyName}`);
              const startTime = Date.now();

              let result: RowEnrichmentResult | null;

              if (mastraPlan) {
                const onProgress = progress(i);
                result = email
                  ? await enrichRowWithMastra({
                      sessionId,
                      rowIndex: i,
                      row,
                      email,
                      plan: mastraPlan.plan,
                      fields: mastraPlan.fields,
                      onProgress: (line) => onProgress(line.message, line.messageType, line.sourceUrl),
                      runs: session.runs,
                      signal: abortController.signal,
                    })
                  : {
                      rowIndex: i,
                      originalData: row,
                      enrichments: {},
                      status: 'error',
                      error: 'No email found in specified column',
                    };

                // Cancelled: the session reports it; nothing is sent for the row.
                if (!result) return;
              } else {
                // Agent strategies return RowEnrichmentResult
                result = await enrichmentStrategy.enrichRow(
                  row,
                  fields,
                  emailColumn,
                  undefined, // onProgress
                  progress(i)
                );
              }
              result.rowIndex = i; // Set the correct row index

              const duration = Date.now() - startTime;
              console.log(`[ENRICHMENT] Completed row ${i + 1} in ${duration}ms - Fields enriched: ${Object.keys(result.enrichments).length}`);

              // Log which fields were successfully enriched
              const enrichedFields = Object.entries(result.enrichments)
                .filter(([, enrichment]) => enrichment.value)
                .map(([fieldName, enrichment]) => `${fieldName}: ${enrichment.value ? '✓' : '✗'}`)
                .join(', ');
              if (enrichedFields) {
                console.log(`[ENRICHMENT] Fields: ${enrichedFields}`);
              }

              // Send result
              send({ type: 'result', result });
            } catch (error) {
              // A cancelled Mastra row can surface as an abort error; it is
              // reported by the session, not as a failed row.
              if (mastraPlan && abortController.signal.aborted) return;

              // Send error for this row
              const errorResult: RowEnrichmentResult = {
                rowIndex: i,
                originalData: row,
                enrichments: {},
                status: 'error',
                error: error instanceof Error ? error.message : 'Unknown error',
              };

              send({ type: 'result', result: errorResult });
            }
          };

          // Create a queue and process with rolling concurrency
          let currentIndex = 0;
          const activePromises: Promise<void>[] = [];
          let cancelled = false;

          // Wake the loop as soon as a DELETE lands, not when the next row ends.
          const aborted = new Promise<void>((resolve) => {
            if (abortController.signal.aborted) resolve();
            abortController.signal.addEventListener('abort', () => resolve(), { once: true });
          });

          while (currentIndex < rows.length || activePromises.length > 0) {
            // Check if cancelled
            if (abortController.signal.aborted) {
              cancelled = true;
              send({ type: 'cancelled' });
              break;
            }

            // Start new rows up to concurrency limit
            while (currentIndex < rows.length && activePromises.length < concurrency) {
              const rowIndex = currentIndex++;
              const promise = processRow(rowIndex).then(() => {
                // Remove this promise from active list when done
                const index = activePromises.indexOf(promise);
                if (index > -1) {
                  activePromises.splice(index, 1);
                }
              });
              activePromises.push(promise);
            }

            // Wait for at least one to finish before continuing
            if (activePromises.length > 0) {
              await Promise.race(mastraEngine ? [...activePromises, aborted] : activePromises);
            }
          }

          // Mastra runs stop promptly once cancelled; let them settle so their
          // last writes land before the stream closes. Legacy rows cannot be
          // stopped, so the legacy path does not wait for them (as before).
          if (cancelled && mastraEngine) {
            await Promise.allSettled(activePromises);
          }

          // Send completion
          if (!cancelled) send({ type: 'complete' });
        } catch (error) {
          send({
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        } finally {
          activeSessions.delete(sessionId);
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
    console.error('Failed to start enrichment:', error);
    return NextResponse.json(
      {
        error: 'Failed to start enrichment',
        details: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      },
      { status: 500 }
    );
  }
}

// Cancel endpoint
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');

  if (!sessionId) {
    return NextResponse.json(
      { error: 'Session ID required' },
      { status: 400 }
    );
  }

  const session = activeSessions.get(sessionId);
  if (session) {
    // Stop new rows, then stop the Mastra runs already going: `Run.cancel()`
    // aborts the run's signal, which the research agents and the Firecrawl
    // tools observe, and marks the run canceled in storage.
    session.controller.abort();
    await Promise.allSettled([...session.runs].map((run) => run.cancel()));
    activeSessions.delete(sessionId);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json(
    { error: 'Session not found' },
    { status: 404 }
  );
}
