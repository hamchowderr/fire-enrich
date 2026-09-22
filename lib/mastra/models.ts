import { gateway, type GatewayModelId } from '@ai-sdk/gateway';
import type { MastraModelConfig } from '@mastra/core/llm';

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

/**
 * Resolve a role to a language model instance routed through the Vercel AI Gateway.
 *
 * Every model call in this app goes through the gateway, so there is exactly one
 * credential to manage and provider SDKs never need to be installed. The gateway
 * provider reads `AI_GATEWAY_API_KEY` from the environment on its own when running
 * locally, and authenticates with OIDC when deployed on Vercel. Neither path needs
 * a provider-specific key such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
 *
 * @param role  Which job the model is doing.
 * @param override  A gateway model id (`provider/model`) that wins over the role
 *   default. This is the hook a per-request enrichment profile will use to pick
 *   its own model.
 */
export function resolveModel(role: ModelRole, override?: string): MastraModelConfig {
  const model = gateway(override ?? DEFAULT_MODEL_IDS[role]);

  // The cast bridges a types-only mismatch between two packages that are
  // correct at runtime.
  //
  // `@mastra/core` 1.67.0 ships a vendored snapshot of `@ai-sdk/provider`
  // 4.0.4 and types `LanguageModelV4` against it. `@ai-sdk/gateway` 4.0.88
  // depends on `@ai-sdk/provider` 4.0.17, which redefined `JSONValue` to use
  // `Readonly<JSONObject>` and `readonly JSONValue[]`. A readonly array is not
  // assignable to a mutable one, so the two `LanguageModelV4` types no longer
  // structurally match even though the object satisfies both specs: the
  // difference is variance on provider metadata, not shape or behaviour.
  //
  // Pinning `@ai-sdk/provider` back for the whole dependency tree would trade a
  // compile-time mismatch for a real runtime risk, so the unsound step is kept
  // to this one boundary. Remove the cast once Mastra vendors a provider
  // snapshot at 4.0.17 or later and this assignment compiles on its own.
  return model as unknown as MastraModelConfig;
}
