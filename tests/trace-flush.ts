/**
 * For the route tests: checks that a route hands `flushTracesAfter`
 * (lib/flush-traces.ts) its task. `after` is mocked in tests/setup.ts to record
 * what it is given, so the tasks registered since {@link watchTraceFlush} are
 * run here by hand, the way Next.js runs them once the response has ended.
 */
import { after } from 'next/server';
import { expect, vi } from 'vitest';

import { mastra } from '@/lib/mastra';

/**
 * Start watching; the returned function runs the `after()` tasks registered
 * since, and asserts the trace buffer was flushed exactly once by them.
 */
export function watchTraceFlush(): () => Promise<void> {
  const flush = vi.spyOn(mastra.observability, 'flush').mockResolvedValue();
  const from = vi.mocked(after).mock.calls.length;

  return async () => {
    const tasks = vi
      .mocked(after)
      .mock.calls.slice(from)
      .map(([task]) => task)
      .filter((task): task is () => Promise<void> => typeof task === 'function');

    expect(flush).not.toHaveBeenCalled();
    await Promise.all(tasks.map((task) => task()));
    expect(flush).toHaveBeenCalledOnce();
  };
}
