import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_MODEL_IDS, resolveModel } from '@/lib/mastra/models';

/**
 * The runtime shape shared by the AI SDK provider models. `MastraModelConfig`
 * hides it, so tests look through the public type to assert on routing.
 */
interface ProviderModel {
  provider: string;
  modelId: string;
  config: {
    baseURL?: string;
    url?: (options: { path: string; modelId: string }) => string;
  };
}

function inspect(role: Parameters<typeof resolveModel>[0], override?: string): ProviderModel {
  return resolveModel(role, override) as unknown as ProviderModel;
}

const ENV_KEYS = ['USE_AIMOCK', 'AIMOCK_URL', 'AIMOCK_MODEL'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('resolveModel with USE_AIMOCK unset', () => {
  beforeEach(() => {
    delete process.env.USE_AIMOCK;
  });

  it('routes the role default through the Vercel AI Gateway', () => {
    const model = inspect('chat');

    expect(model.provider).toBe('gateway');
    expect(model.modelId).toBe(DEFAULT_MODEL_IDS.chat);
    expect(model.config.baseURL).toMatch(/^https:\/\/ai-gateway\.vercel\.sh\//);
  });

  it('resolves each role to its own default', () => {
    expect(inspect('planner').modelId).toBe(DEFAULT_MODEL_IDS.planner);
    expect(inspect('research').modelId).toBe(DEFAULT_MODEL_IDS.research);
  });

  it('lets an override win over the role default', () => {
    const model = inspect('chat', 'openai/gpt-4.1-mini');

    expect(model.provider).toBe('gateway');
    expect(model.modelId).toBe('openai/gpt-4.1-mini');
  });

  it('treats any USE_AIMOCK value other than "true" as off', () => {
    process.env.USE_AIMOCK = '1';

    expect(inspect('chat').provider).toBe('gateway');
  });
});

describe('resolveModel with USE_AIMOCK=true', () => {
  beforeEach(() => {
    process.env.USE_AIMOCK = 'true';
    process.env.AIMOCK_URL = 'http://127.0.0.1:4999';
    delete process.env.AIMOCK_MODEL;
  });

  it('returns an OpenAI-compatible chat model pointed at AIMOCK_URL', () => {
    const model = inspect('chat');

    expect(model.provider).toBe('openai.chat');
    expect(model.modelId).toBe('gpt-4o-mini');
    expect(model.config.url?.({ path: '/chat/completions', modelId: model.modelId })).toBe(
      'http://127.0.0.1:4999/v1/chat/completions'
    );
  });

  it('tolerates a trailing slash on AIMOCK_URL', () => {
    process.env.AIMOCK_URL = 'http://127.0.0.1:4999/';

    const model = inspect('chat');

    expect(model.config.url?.({ path: '/chat/completions', modelId: model.modelId })).toBe(
      'http://127.0.0.1:4999/v1/chat/completions'
    );
  });

  it('sends AIMOCK_MODEL as the model id when set', () => {
    process.env.AIMOCK_MODEL = 'mock-planner';

    expect(inspect('planner').modelId).toBe('mock-planner');
  });

  it('uses the single mock model id for every role and ignores the override', () => {
    expect(inspect('planner').modelId).toBe('gpt-4o-mini');
    expect(inspect('chat', 'openai/gpt-4.1-mini').modelId).toBe('gpt-4o-mini');
    expect(inspect('chat', 'openai/gpt-4.1-mini').provider).toBe('openai.chat');
  });
});
