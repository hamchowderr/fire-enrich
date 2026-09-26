/**
 * `flushTracesAfter` and `pruneTraces` (lib/flush-traces.ts): the flush and the
 * prune run inside `after()` (mocked in tests/setup.ts to record its argument),
 * only once the route's work has settled, never throw, and the prune is
 * throttled per instance.
 */
import { after } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushTracesAfter, pruneTraces } from '@/lib/flush-traces';
import { mastra } from '@/lib/mastra';

type State = typeof globalThis & { __fireEnrichLastPrune?: number };

/** The task the last `after()` call registered. */
function lastTask(): () => Promise<void> {
  const task = vi.mocked(after).mock.calls.at(-1)?.[0];
  expect(typeof task).toBe('function');
  return task as () => Promise<void>;
}

let flush: ReturnType<typeof vi.spyOn>;
let prune: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete (globalThis as State).__fireEnrichLastPrune;
  vi.mocked(after).mockClear();
  flush = vi.spyOn(mastra.observability, 'flush').mockResolvedValue();
  prune = vi.fn().mockResolvedValue([{ domain: 'observability', table: 'mastra_ai_spans', deleted: 0, done: true }]);
  vi.spyOn(mastra, 'getStorage').mockReturnValue({ prune } as unknown as ReturnType<typeof mastra.getStorage>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('flushTracesAfter', () => {
  it('registers one after() task that flushes, then prunes, once `done` settles', async () => {
    const done = Promise.withResolvers<void>();
    flushTracesAfter(done.promise);
    expect(after).toHaveBeenCalledTimes(1);

    const running = lastTask()();
    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();

    done.resolve();
    await running;
    expect(flush).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith({ maxRows: 5_000 });
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(prune.mock.invocationCallOrder[0]);
  });

  it('runs without a promise, and after a rejected one', async () => {
    flushTracesAfter();
    await lastTask()();
    flushTracesAfter(Promise.reject(new Error('stream failed')));
    delete (globalThis as State).__fireEnrichLastPrune;
    await lastTask()();
    expect(flush).toHaveBeenCalledTimes(2);
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('never throws: a failed flush or prune is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    flush.mockRejectedValue(new Error('turso down'));
    prune.mockRejectedValue(new Error('turso down'));

    flushTracesAfter();
    await expect(lastTask()()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[TRACING] flush failed:', 'turso down');
    expect(warn).toHaveBeenCalledWith('[TRACING] prune failed:', 'turso down');
  });
});

describe('pruneTraces', () => {
  it('prunes at most once an hour per instance', async () => {
    await pruneTraces(1_000_000);
    await pruneTraces(1_000_000 + 59 * 60_000);
    expect(prune).toHaveBeenCalledTimes(1);

    await pruneTraces(1_000_000 + 60 * 60_000);
    expect(prune).toHaveBeenCalledTimes(2);
  });

  it('logs how many spans it deleted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    prune.mockResolvedValue([{ domain: 'observability', table: 'mastra_ai_spans', deleted: 42, done: false }]);
    await pruneTraces();
    expect(log).toHaveBeenCalledWith('[TRACING] pruned 42 expired span(s)');
  });
});
