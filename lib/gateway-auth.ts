import { getVercelOidcTokenSync } from '@vercel/oidc';

/**
 * Whether the AI Gateway has a credential to authenticate with.
 *
 * `@ai-sdk/gateway` authenticates with `AI_GATEWAY_API_KEY` when it is set and
 * otherwise with the deployment's Vercel OIDC token, which it obtains through
 * `@vercel/oidc`. Inside a Vercel function that token is not an environment
 * variable: it arrives on the request context as the `x-vercel-oidc-token`
 * header. `VERCEL_OIDC_TOKEN` is populated only at build time and in local
 * development after `vercel env pull`, so a bare environment check reports the
 * gateway unconfigured on every deployed request.
 *
 * The lookup is the package's own `getVercelOidcTokenSync`, the function the
 * gateway itself starts from: the request context first, the environment
 * second, a throw when neither holds a token. The async `getVercelOidcToken`
 * is deliberately not used: it also parses the token as a JWT and, when it is
 * expired, mints a new one through the Vercel CLI's stored login, a network
 * round trip a presence check must not trigger.
 *
 * Returns a boolean only; the token value never leaves this function.
 */
export function gatewayConfigured(): boolean {
  if (process.env.AI_GATEWAY_API_KEY) return true;

  try {
    return Boolean(getVercelOidcTokenSync());
  } catch {
    return false;
  }
}
