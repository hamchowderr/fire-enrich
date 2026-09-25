/**
 * TLS for the Dolt connection: trust only the pinned CA, and check that the
 * server's certificate names `DOLT_HOST`.
 *
 * Shared by the app (`lib/dolt.ts`) and the migrate script
 * (`scripts/db-migrate.mjs`), so both connect the same way. Plain `.mjs` for
 * the same reason as `lib/dolt-config.mjs`: the script runs under plain Node.
 *
 * How the name is checked depends on the kind of host, because `mysql2`
 * (3.24.4) checks it only for a DNS name:
 *
 * - DNS name: `ssl.verifyIdentity` makes `mysql2` run Node's
 *   `tls.checkServerIdentity` during the TLS handshake, before it sends the
 *   credentials.
 * - IP address: `mysql2` gives Node no server name for an IP host, so with
 *   `verifyIdentity` Node checks the name `localhost` instead of the address:
 *   a correct IP-SAN certificate fails and a certificate for `localhost`
 *   passes. `mysql2` also ignores a `checkServerIdentity` function in `ssl`
 *   (sidorares/node-mysql2#2177). So `verifyIdentity` stays off, and
 *   {@link doltServerIdentityError} runs Node's `tls.checkServerIdentity`
 *   against the address on the open connection, before its first statement.
 *
 * For an IP host that check comes after the login, so it does not protect
 * the credentials: a server whose certificate chains to `DOLT_TLS_CA_B64` can
 * ask for `sha256_password` or `caching_sha2_password` full authentication,
 * and `mysql2` then sends the plaintext password inside TLS, whatever plugin
 * the account uses. Only the CA pin protects the password there, which is why
 * `DOLT_TLS_CA_B64` must be the server's own certificate or a private CA used
 * only for it, never a shared or public CA. A DNS name moves the check into
 * the handshake, before any credentials are sent.
 *
 * The IP path can likely go once `mysql2` lets the caller set the TLS server
 * name (`ssl.servername`, sidorares/node-mysql2#3845, open) or pass
 * `checkServerIdentity` (#2295, open). Either would let Node check the
 * address during the handshake, as it does for a DNS name.
 */
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';

/**
 * `ssl` option objects (one per pool, or per dedicated connection) that have
 * completed a full TLS handshake whose certificate named the IP host.
 *
 * `mysql2` keeps TLS sessions per `ssl` object and resumes them on later
 * connections. A resumed connection has no peer certificate to check, so it
 * is accepted only when the same `ssl` object's last full handshake passed.
 * A failed check removes the object, so a session from that server is refused.
 *
 * @type {WeakSet<object>}
 */
const verifiedSsl = new WeakSet();

/**
 * The `mysql2` `ssl` options for `DOLT_TLS_CA_B64`, or `undefined` when it is
 * unset (a local server without TLS).
 *
 * `ca` is the only trust anchor: Node's default CAs are not used, and
 * `rejectUnauthorized` keeps its default, `true`.
 *
 * @param {string} host The `DOLT_HOST` the connection uses.
 * @param {string | undefined} caB64 `DOLT_TLS_CA_B64`: the CA certificate (PEM), base64.
 * @returns {{ ca: Buffer, verifyIdentity: boolean } | undefined}
 */
export function doltSslOptions(host, caB64) {
  if (!caB64) return undefined;
  return { ca: Buffer.from(caB64, 'base64'), verifyIdentity: isIP(host) === 0 };
}

/**
 * For an IP host, check that the server on an open TLS connection has a
 * certificate for that address. Returns the error from Node's
 * `tls.checkServerIdentity`, or `undefined` when the address matches, the
 * host is a DNS name (checked during the handshake), or the connection has no
 * `ssl` options.
 *
 * @param {{ config?: { ssl?: unknown }, stream?: unknown }} connection A
 *   `mysql2` core connection: `connection` on a promise connection or a pool
 *   connection.
 * @param {string} host The `DOLT_HOST` the connection uses.
 * @returns {Error | undefined}
 */
export function doltServerIdentityError(connection, host) {
  const ssl = connection.config?.ssl;
  if (!ssl || typeof ssl !== 'object' || isIP(host) === 0) return undefined;

  const socket =
    /** @type {{ getPeerCertificate?: () => import('node:tls').PeerCertificate, isSessionReused?: () => boolean }} */ (
      connection.stream
    );
  if (typeof socket?.getPeerCertificate !== 'function') {
    return new Error(`Dolt connection to ${host} is not using TLS, but DOLT_TLS_CA_B64 is set.`);
  }

  if (socket.isSessionReused?.()) {
    return verifiedSsl.has(ssl)
      ? undefined
      : new Error(
          `Dolt connection to ${host} resumed a TLS session that no checked connection opened.`
        );
  }

  const error = checkServerIdentity(host, socket.getPeerCertificate());
  if (error) verifiedSsl.delete(ssl);
  else verifiedSsl.add(ssl);
  return error;
}
