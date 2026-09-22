import { gateway, type GatewayModelId } from '@ai-sdk/gateway';
import { createOpenAI } from '@ai-sdk/openai';
import type { MastraModelConfig } from '@mastra/core/llm';

import { aimockBaseUrl, isAIMockEnabled } from './lib/aimock';

/**
 * Model roles used across the Mastra layer.
 *
 * A role names the *job* a model is doing, not a specific model. Callers ask
 * for a role; this module decides which model id serves it.
 */
export type ModelRole = 'planner' | 'research' | 'chat';

/**
 * Default model id per role.
 *
 * These are code defaults, deliberately not environment variables: the model a
 * request uses is a product decision that belongs in version control and, later,
 * in a per-request enrichment profile. Changing a default is a reviewable commit.
 * To use a different model for a single call, pass `override` to
 * {@link resolveModel} rather than adding an env var.
 *
 * @public Part of this module's API. Nothing imports it yet; enrichment profiles
 * will read it to show which model a role falls back to.
 */
export const DEFAULT_MODEL_IDS: Record<ModelRole, GatewayModelId> = {
  planner: 'anthropic/claude-sonnet-4.5',
  research: 'anthropic/claude-sonnet-4.5',
  chat: 'anthropic/claude-haiku-4.5',
};

/** Model id sent to AIMock unless `AIMOCK_MODEL` says otherwise. */
const DEFAULT_AIMOCK_MODEL = 'gpt-4o-mini';

/**
 * Resolve a role to a language model instance.
 *
 * This is the single switch between the real and the mocked model path:
 *
 * - **Default: Vercel AI Gateway.** Every model call goes through the gateway,
 *   so there is exactly one credential to manage and provider SDKs never need
 *   to be installed for production. The gateway provider reads
 *   `AI_GATEWAY_API_KEY` from the environment on its own when running locally,
 *   and authenticates with OIDC when deployed on Vercel.
 * - **`USE_AIMOCK=true`: AIMock.** The gateway wire format is not what AIMock
 *   speaks, so tests use `@ai-sdk/openai` pointed at the mock server's
 *   OpenAI-compatible `/v1/chat/completions`. The model id is a single mock
 *   id (`AIMOCK_MODEL`, default `gpt-4o-mini`) regardless of role or override:
 *   under AIMock the response comes from a fixture, not from a model, and one
 *   id keeps fixtures simple. Tests that care which gateway model a role or
 *   override resolves to assert on the gateway path instead.
 *
 * @param role  Which job the model is doing.
 * @param override  A gateway model id (`provider/model`) that wins over the role
 *   default. This is the hook a per-request enrichment profile will use to pick
 *   its own model.
 */
export function resolveModel(role: ModelRole, override?: string): MastraModelConfig {
  if (isAIMockEnabled()) {
    // `.chat()` selects the Chat Completions API. The provider's bare call
    // would use the Responses API, which AIMock also serves, but Chat
    // Completions is the endpoint its fixture format is documented against.
    const openai = createOpenAI({ baseURL: `${aimockBaseUrl()}/v1`, apiKey: 'mock' });

    return toMastraModel(openai.chat(process.env.AIMOCK_MODEL ?? DEFAULT_AIMOCK_MODEL));
  }

  return toMastraModel(gateway(override ?? DEFAULT_MODEL_IDS[role]));
}

/**
 * Bridge a types-only mismatch between two packages that are correct at runtime.
 *
 * `@mastra/core` 1.67.0 ships a vendored snapshot of `@ai-sdk/provider` 4.0.4
 * and types `LanguageModelV4` against it. `@ai-sdk/gateway` 4.0.88 and
 * `@ai-sdk/openai` 4.0.72 both depend on `@ai-sdk/provider` 4.0.17, which
 * redefined `JSONValue` to use `Readonly<JSONObject>` and `readonly JSONValue[]`.
 * A readonly array is not assignable to a mutable one, so the two
 * `LanguageModelV4` types no longer structurally match even though the object
 * satisfies both specs: the difference is variance on provider metadata, not
 * shape or behaviour.
 *
 * Pinning `@ai-sdk/provider` back for the whole dependency tree would trade a
 * compile-time mismatch for a real runtime risk, so the unsound step is kept
 * to this one boundary. Remove this function once Mastra vendors a provider
 * snapshot at 4.0.17 or later and the assignment compiles on its own.
 *
 * The parameter is typed through the gateway's return type rather than by
 * importing `@ai-sdk/provider`, which is not a direct dependency.
 */
function toMastraModel(model: ReturnType<typeof gateway>): MastraModelConfig {
  return model as unknown as MastraModelConfig;
}
