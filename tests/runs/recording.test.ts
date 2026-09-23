import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Imported once: the adapter pulls in the Mastra instance, which is slow to
// load. The Dolt client reads its environment per call, so nothing needs a
// fresh module between tests.
import { startRunRecording } from '@/lib/mastra/enrich-adapter';
import type { EnrichmentResult } from '@/lib/types';

import { configureDolt, installFakeDolt, isolateDoltEnv } from './fake-dolt';

/**
 * The adapter's run recording (`RunRecording` in `lib/mastra/enrich-adapter.ts`)
 * over a fake Dolt: storage failures never throw into enrichment, and are
 * reported once, as one generic `agent_progress` warning. The cause goes to
 * the server log, never to the browser.
 */
const { createPool, createConnection } = vi.hoisted(() => ({ createPool: vi.fn(), createConnection: vi.fn() }));

vi.mock('mysql2/promise', () => ({ default: { createPool, createConnection } }));

const fake = installFakeDolt(createPool, createConnection);
let restoreEnv: () => void;
let warnLog: ReturnType<typeof vi.spyOn>;

const ENRICHMENT: EnrichmentResult = {
  field: 'headline',
  value: 'Power AI agents with clean web data',
  confidence: 0.9,
  sourceContext: [{ url: 'https://www.firecrawl.dev/', snippet: 'Power AI agents with clean web data' }],
};

/** A recording plus the warnings it sent, as the route would stream them. */
async function start(planId?: string) {
  const warnings: Array<{ rowIndex: number; message: string; messageType: string }> = [];
  const recording = await startRunRecording({
    planId,
    listRef: 'contacts.csv',
    warn: (rowIndex, line) => warnings.push({ rowIndex, message: line.message, messageType: line.messageType }),
  });
  return { recording, warnings };
}

beforeEach(() => {
  restoreEnv = isolateDoltEnv();
  fake.reset();
  createPool.mockClear();
  createConnection.mockClear();
  warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

describe('RunRecording without Dolt', () => {
  it('does not throw, touches no database, and warns once on the first recorded row', async () => {
    const { recording, warnings } = await start();

    await recording.recordRow(0, 'a@a.example', { headline: ENRICHMENT }, {});
    await recording.recordRow(1, 'b@b.example', { headline: ENRICHMENT }, {});
    await expect(recording.finish('completed')).resolves.toBeNull();

    expect(warnings).toEqual([{ rowIndex: 0, message: 'run not recorded: storage unavailable', messageType: 'warning' }]);
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(warnLog).toHaveBeenCalledWith(expect.stringContaining('Dolt is not configured'));
    expect(createPool).not.toHaveBeenCalled();
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('stays quiet when no row is recorded (every row skipped)', async () => {
    const { recording, warnings } = await start();

    await recording.finish('completed');

    expect(warnings).toEqual([]);
  });
});

describe('RunRecording with Dolt down', () => {
  it('reports the connection failure once, without its detail, and keeps going', async () => {
    configureDolt();
    fake.respond(/DOLT_BRANCH/, () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3316'), { code: 'ECONNREFUSED' });
    });

    const { recording, warnings } = await start();
    await recording.recordRow(3, 'a@a.example', { headline: ENRICHMENT }, {});
    await recording.recordRow(4, 'b@b.example', { headline: ENRICHMENT }, {});
    await recording.finish('completed');

    expect(warnings).toEqual([{ rowIndex: 3, message: 'run not recorded: storage unavailable', messageType: 'warning' }]);
    // The driver error names the host; it is logged, not streamed.
    expect(warnLog).toHaveBeenCalledTimes(1);
    expect(warnLog).toHaveBeenCalledWith('[RUNS] run not recorded: connect ECONNREFUSED 127.0.0.1:3316');
    expect(fake.find(/INSERT|DOLT_COMMIT|DOLT_MERGE/)).toEqual([]);
  });

  it('stops recording after a failed row write and does not commit a half-written run', async () => {
    configureDolt();
    fake.respond(/INSERT INTO enrichments/, () => {
      throw new Error('lost connection to server');
    });

    const { recording, warnings } = await start();
    await recording.recordRow(0, 'a@a.example', { headline: ENRICHMENT }, {});
    await recording.recordRow(1, 'b@b.example', { headline: ENRICHMENT }, {});
    await expect(recording.finish('completed')).resolves.toBeNull();

    expect(warnings).toEqual([{ rowIndex: 0, message: 'run not recorded: storage unavailable', messageType: 'warning' }]);
    expect(warnLog).toHaveBeenCalledWith('[RUNS] run not recorded: lost connection to server');
    expect(fake.find(/INSERT INTO enrichments/)).toHaveLength(1);
    expect(fake.find(/DOLT_COMMIT|DOLT_MERGE/)).toEqual([]);
    // The run's branch connection is closed, not leaked.
    expect(fake.connections[0].end).toHaveBeenCalled();
  });

  it('warns, without throwing, when the final commit fails', async () => {
    configureDolt();
    fake.respond(/DOLT_COMMIT/, () => {
      throw new Error('database is read only');
    });

    const { recording, warnings } = await start();
    await recording.recordRow(0, 'a@a.example', { headline: ENRICHMENT }, {});
    await expect(recording.finish('completed')).resolves.toBeNull();

    expect(warnings).toEqual([{ rowIndex: 0, message: 'run not recorded: storage unavailable', messageType: 'warning' }]);
    expect(warnLog).toHaveBeenCalledWith('[RUNS] run not recorded: database is read only');
  });
});

describe('RunRecording with Dolt up', () => {
  it('passes the plan id through, records rows with their strategies, and finishes once', async () => {
    configureDolt();

    const { recording, warnings } = await start('plan_saved');
    await recording.recordRow(0, 'a@a.example', { headline: ENRICHMENT }, { headline: 'search' });
    const hash = await recording.finish('partial');
    await recording.finish('completed');
    // A row that lands after the commit is not written to a closed run.
    await recording.recordRow(1, 'late@b.example', { headline: ENRICHMENT }, {});

    expect(warnings).toEqual([]);
    expect(fake.find(/INSERT INTO enrichment_runs/)[0].params[1]).toBe('plan_saved');
    expect((fake.find(/INSERT INTO enrichments/)[0].params[0] as unknown[][])[0].slice(2)).toEqual([
      'a@a.example',
      'headline',
      'Power AI agents with clean web data',
      0.9,
      'search',
    ]);
    expect(fake.find(/SET status/).map((statement) => statement.params[0])).toEqual(['partial']);
    expect(fake.find(/INSERT INTO enrichments/)).toHaveLength(1);
    expect(hash).toBe(fake.hashes[0]);
  });
});
