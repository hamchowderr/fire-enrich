/**
 * Tier-2 tool: Firecrawl's hosted research agent.
 *
 * What matters here is the loop the tool runs in place of the SDK's blocking
 * `agent()`: it starts the job, polls every 3s, and on abort stops polling
 * *and* cancels the remote job — the thing the blocking waiter cannot do, and
 * the reason a hosted run is not left billing after a cancelled enrichment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import agentFixture from '../fixtures/firecrawl/agent.json';

import { apiError, never, progressEvents, recordingWriter, runTool } from './helpers';

const { startAgentMock, getAgentStatusMock, cancelAgentMock } = vi.hoisted(() => ({
  startAgentMock: vi.fn(),
  getAgentStatusMock: vi.fn(),
  cancelAgentMock: vi.fn(),
}));

vi.mock('firecrawl', () => ({
  Firecrawl: class {
    startAgent = startAgentMock;
    getAgentStatus = getAgentStatusMock;
    cancelAgent = cancelAgentMock;
  },
}));

// Imported after the mock is declared; `vi.mock` is hoisted above imports.
import { firecrawlAgentTool } from '@/lib/mastra/tools/firecrawl-agent';

interface AgentToolInput {
  prompt: string;
  urls?: string[];
  schema?: Record<string, unknown>;
}

interface AgentToolOutput {
  status: 'completed' | 'failed';
  data: unknown;
  sources: string[];
  error?: string;
}

const processing = { success: true, status: 'processing', expiresAt: '2026-09-29T00:00:00.000Z' };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  startAgentMock.mockResolvedValue({ success: true, id: 'job_fixture_0001' });
  cancelAgentMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  startAgentMock.mockReset();
  getAgentStatusMock.mockReset();
  cancelAgentMock.mockReset();
});

describe('firecrawlAgentTool', () => {
  it('forwards the caller’s prompt, urls and schema verbatim', async () => {
    getAgentStatusMock.mockResolvedValueOnce(agentFixture);
    const schema = { type: 'object', properties: { company: { type: 'string' } } };

    await runTool<AgentToolInput, AgentToolOutput>(firecrawlAgentTool, {
      prompt: 'Who makes Firecrawl and where is it documented?',
      urls: ['https://firecrawl.dev'],
      schema,
    });

    expect(startAgentMock).toHaveBeenCalledWith({
      prompt: 'Who makes Firecrawl and where is it documented?',
      urls: ['https://firecrawl.dev'],
      schema,
    });
  });

  it('polls every three seconds until the job leaves `processing`', async () => {
    vi.useFakeTimers();
    getAgentStatusMock
      .mockResolvedValueOnce(processing)
      .mockResolvedValueOnce(processing)
      .mockResolvedValueOnce(agentFixture);

    const pending = runTool<AgentToolInput, AgentToolOutput>(firecrawlAgentTool, {
      prompt: 'anything',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(getAgentStatusMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(getAgentStatusMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(getAgentStatusMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;

    expect(getAgentStatusMock).toHaveBeenCalledTimes(3);
    expect(getAgentStatusMock).toHaveBeenCalledWith('job_fixture_0001');
    expect(result.status).toBe('completed');
    expect(result.data).toMatchObject({ company: 'Firecrawl' });
  });

  it('attributes the answer to the pinned urls and to urls found in the data', async () => {
    getAgentStatusMock.mockResolvedValueOnce(agentFixture);

    const result = await runTool<AgentToolInput, AgentToolOutput>(firecrawlAgentTool, {
      prompt: 'anything',
      urls: ['https://firecrawl.dev'],
    });

    expect(result.sources).toContain('https://firecrawl.dev');
    expect(result.sources).toContain(agentFixture.data.website);
    expect(result.sources).toContain(agentFixture.data.github);
  });

  it('never offers a blocked domain as a source', async () => {
    getAgentStatusMock.mockResolvedValueOnce({
      success: true,
      status: 'completed',
      expiresAt: '',
      data: {
        homepage: 'https://acme.example',
        social: 'https://www.linkedin.com/company/acme',
      },
    });

    const result = await runTool<AgentToolInput, AgentToolOutput>(firecrawlAgentTool, {
      prompt: 'anything',
      urls: ['https://x.com/acme'],
    });

    expect(result.sources).toEqual(['https://acme.example']);
  });

  it('reports a failed run rather than throwing', async () => {
    getAgentStatusMock.mockResolvedValueOnce({
      success: false,
      status: 'failed',
      expiresAt: '',
      error: 'Could not reach any source',
    });

    const result = await runTool<AgentToolInput, AgentToolOutput>(firecrawlAgentTool, {
      prompt: 'anything',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Could not reach any source');
    expect(result.sources).toEqual([]);
  });

  it('throws when the job never starts', async () => {
    startAgentMock.mockResolvedValueOnce({ success: false, id: '', error: 'quota exhausted' });

    await expect(runTool(firecrawlAgentTool, { prompt: 'anything' })).rejects.toThrow(
      'quota exhausted'
    );
    expect(getAgentStatusMock).not.toHaveBeenCalled();
  });

  it('retries a transient status check instead of failing the run', async () => {
    vi.useFakeTimers();
    getAgentStatusMock
      .mockRejectedValueOnce(apiError(503, 'Unavailable'))
      .mockResolvedValueOnce(agentFixture);

    const pending = runTool<AgentToolInput, AgentToolOutput>(firecrawlAgentTool, {
      prompt: 'anything',
    });
    await vi.runAllTimersAsync();

    expect((await pending).status).toBe('completed');
    expect(getAgentStatusMock).toHaveBeenCalledTimes(2);
  });

  it('stops polling and cancels the remote job when the signal aborts', async () => {
    vi.useFakeTimers();
    getAgentStatusMock.mockResolvedValue(processing);
    const controller = new AbortController();

    const pending = runTool(
      firecrawlAgentTool,
      { prompt: 'anything' },
      { abortSignal: controller.signal }
    );
    const outcome = expect(pending).rejects.toThrow(/abort/i);

    await vi.advanceTimersByTimeAsync(0); // job started, first poll done, now sleeping
    expect(getAgentStatusMock).toHaveBeenCalledTimes(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    await outcome;
    expect(cancelAgentMock).toHaveBeenCalledWith('job_fixture_0001');
    // The abort landed during the sleep, so no further status check went out.
    expect(getAgentStatusMock).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when the signal aborts while the job is starting', async () => {
    startAgentMock.mockImplementation(() => never());
    const controller = new AbortController();

    const pending = runTool(
      firecrawlAgentTool,
      { prompt: 'anything' },
      { abortSignal: controller.signal }
    );
    const outcome = expect(pending).rejects.toThrow(/abort/i);
    controller.abort();

    await outcome;
    // There is no job id yet, so there is nothing to cancel.
    expect(cancelAgentMock).not.toHaveBeenCalled();
  });

  it('writes progress for the start, each poll, and every source it found', async () => {
    vi.useFakeTimers();
    getAgentStatusMock.mockResolvedValueOnce(processing).mockResolvedValueOnce(agentFixture);
    const writer = recordingWriter();

    const pending = runTool(
      firecrawlAgentTool,
      { prompt: 'who makes firecrawl' },
      { writer: writer as never }
    );
    await vi.runAllTimersAsync();
    await pending;

    const events = progressEvents(writer);
    expect(events[0]).toEqual({
      type: 'firecrawl-progress',
      message: 'Starting a Firecrawl research agent: who makes firecrawl',
    });
    expect(events[1]).toEqual({
      type: 'firecrawl-progress',
      message: 'Research agent job_fixture_0001 is still working',
    });
    expect(events.filter((event) => event.sourceUrl)).toContainEqual({
      type: 'firecrawl-progress',
      message: 'Agent source',
      sourceUrl: agentFixture.data.website,
    });
  });
});
