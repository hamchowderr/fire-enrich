/**
 * The AIMock url, for a test file that talks to AIMock. Importing it also
 * gives every request in the file a connection of its own.
 *
 * AIMock is a Node http server, so it closes a keep-alive socket after 5 s
 * idle. The client drops an idle socket after 3 s (the server's hint less
 * undici's 2 s threshold), but only when its event loop runs on time. A worker
 * that is starved for longer, as happens when two suites share a machine, can
 * send its next request down a socket the server has already closed, and the
 * request fails with ECONNRESET. With `pipelining: 0` undici keeps no socket
 * alive between requests. `setGlobalDispatcher` also sets the dispatcher of
 * Node's built-in `fetch`, which the AI SDK and these tests use.
 *
 * Only the files that talk to AIMock import this module, so the other files
 * do not load undici.
 */
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ pipelining: 0 }));

/** Set by `tests/setup.ts` when the environment does not set it. */
export const AIMOCK_URL = process.env.AIMOCK_URL as string;
