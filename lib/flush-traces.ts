import { after } from 'next/server';

import { mastra } from '@/lib/mastra';

/**
 * Write the spans the trace exporter still holds, inside Next.js `after()`,
 * once `done` settles (or once the response is sent, without it).
 *
 * The exporter (`lib/mastra/tracing.ts`) buffers spans and writes them in
 * batches up to 5 s apart. On Vercel a function can be frozen as soon as its
 * work ends, which would leave the last batch in memory. `after()` runs once
 * the response is finished, so the flush adds no latency to it. A streaming
 * route passes the promise that settles when its stream ends; a plain route
 * passes nothing. Never throws: a failed flush is logged and dropped. With
 * tracing off the flush is a no-op.
 */
export function flushTracesAfter(done?: Promise<unknown>): void {
  after(async () => {
    await done?.catch(() => {});
    try {
      await mastra.observability.flush();
    } catch (error) {
      console.warn('[TRACING] flush failed:', error instanceof Error ? error.message : error);
    }
  });
}
