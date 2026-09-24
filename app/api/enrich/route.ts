import { NextRequest, NextResponse } from 'next/server';
import type { EnrichmentRequest, RowEnrichmentResult } from '@/lib/types';
import { loadSkipList, shouldSkipEmail, getSkipReason } from '@/lib/utils/skip-list';
import { ENRICHMENT_CONFIG } from '@/lib/config/enrichment';
import { gatewayConfigured } from '@/lib/gateway-auth';
import {
  enrichRowWithMastra,
  resolveSessionPlan,
  startRunRecording,
  type CancellableRun,
  type RunRecording,
} from '@/lib/mastra/enrich-adapter';
import { listRefFor } from '@/lib/runs';

// Use Node.js runtime for better compatibility
export const runtime = 'nodejs';

/**
 * A running session: the controller that stops new rows from starting, and
 * the Mastra runs still in flight, so a DELETE or a client disconnect can
 * cancel them as well.
 */
interface ActiveSession {
  controller: AbortController;
  runs: Set<CancellableRun>;
}

/** How long a cancelled session waits for its Mastra rows to settle before closing. */
const CANCEL_SETTLE_MS = 15_000;

// Store active sessions in memory (in production, use Redis or similar)
const activeSessions = new Map<string, ActiveSession>();

/**
 * Stop a session: no new rows start, and the Mastra runs already going are
 * cancelled. `Run.cancel()` aborts the run's signal, which the research agents
 * and the Firecrawl tools observe, and marks the run canceled in storage.
 * Shared by DELETE and a client disconnect. False when there is no such session.
 */
async function cancelSession(sessionId: string): Promise<boolean> {
  const session = activeSessions.get(sessionId);
  if (!session) return false;

  session.controller.abort();
  await Promise.allSettled([...session.runs].map((run) => run.cancel()));
  activeSessions.delete(sessionId);
  return true;
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

    // `listRef` (optional): how the caller names the list, e.g. the CSV file
    // name. Without it the run is recorded under a fingerprint of the emails.
    const body: EnrichmentRequest & { listRef?: unknown } = await request.json();
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
    // secrets manager at runtime and are never read from the request. The
    // gateway's credential is its key or, on Vercel, the deployment's OIDC
    // token; `gatewayConfigured` checks both the way the gateway does.
    const hasGateway = gatewayConfigured();
    const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;

    if (!hasGateway || !firecrawlApiKey) {
      console.error('Missing API keys:', {
        hasGateway,
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

    // Load skip list
    const skipList = await loadSkipList();

    // Create a streaming response
    const encoder = new TextEncoder();
    // Rows still in flight after a cancel can finish a moment later; once
    // the stream is closed their writes are dropped instead of throwing.
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };

        // The session's run in Dolt. Never throws: with
        // storage unavailable it says so once in the stream and rows go on.
        let recording: RunRecording | null = null;

        try {
          // Send session ID
          send({ type: 'session', sessionId });

          // Process rows with rolling concurrency (as each finishes, start the next)
          const concurrency = ENRICHMENT_CONFIG.MASTRA_CONCURRENT_ROWS;
          console.log(`[ENRICHMENT] Processing ${rows.length} rows with rolling concurrency: ${concurrency}`);

          // Send pending status for all rows
          for (let i = 0; i < rows.length; i++) {
            send({ type: 'pending', rowIndex: i, totalRows: rows.length });
          }

          // The plan is resolved once for the whole session —
          // the cached plan behind these fields, or one from the planner — and
          // passes it to every row, so a cold cache costs one planner call, not
          // one per concurrent row. Resolved after `pending` so the table fills
          // while a miss is being planned.
          const mastraPlan = await resolveSessionPlan(fields, abortController.signal);

          recording = await startRunRecording({
            planId: mastraPlan.planId,
            listRef: listRefFor(body.listRef, rows, emailColumn),
            warn: (rowIndex, line) =>
              send({ type: 'agent_progress', rowIndex, message: line.message, messageType: line.messageType }),
          });

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
              console.log(`[ENRICHMENT] Processing row ${i + 1}/${rows.length} - Email: ${email}`);
              const startTime = Date.now();

              const onProgress = progress(i);
              const result: RowEnrichmentResult | null = email
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
                    recording: recording ?? undefined,
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
              if (abortController.signal.aborted) return;

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
              await Promise.race([...activePromises, aborted]);
            }
          }

          // Mastra runs stop promptly once cancelled; let them settle so their
          // last writes land before the stream closes. The wait is bounded, so a
          // tool that ignores the abort signal cannot hold the stream open.
          if (cancelled) {
            await Promise.race([
              Promise.allSettled(activePromises),
              new Promise((resolve) => setTimeout(resolve, CANCEL_SETTLE_MS)),
            ]);
          }

          // Commit the run before the stream ends: a cancelled run is
          // `partial`, with the rows that finished.
          await recording?.finish(cancelled ? 'partial' : 'completed');

          // Send completion. `runId`: the committed run every row of this
          // session belongs to, for `GET /api/runs/:id/diff`; null when the
          // run was not recorded.
          if (!cancelled) send({ type: 'complete', runId: recording?.committedRunId ?? null });
        } catch (error) {
          // A no-op when the run already finished or was never started.
          await recording?.finish(abortController.signal.aborted ? 'partial' : 'failed');

          // A DELETE during plan resolution rejects the planner call on the
          // abort signal; that is a cancel, not a failure.
          if (abortController.signal.aborted) {
            send({ type: 'cancelled' });
            return;
          }

          send({
            type: 'error',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        } finally {
          activeSessions.delete(sessionId);
          // A disconnected client has already closed the stream.
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      },
      // The client went away (tab closed, fetch aborted) without a DELETE:
      // stop the session the same way, so its rows stop spending credits.
      async cancel() {
        closed = true;
        console.log(`[ENRICHMENT] Client disconnected; cancelling session ${sessionId}`);
        await cancelSession(sessionId);
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

  if (await cancelSession(sessionId)) {
    return NextResponse.json({ success: true });
  }

  return NextResponse.json(
    { error: 'Session not found' },
    { status: 404 }
  );
}
