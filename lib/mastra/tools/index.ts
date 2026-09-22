/**
 * The one type the tools' consumers share.
 *
 * `FirecrawlProgressEvent` is what every Firecrawl tool writes to its stream;
 * the enrich-row workflow forwards those events (with `groupId` added) onto
 * its step stream, and the SSE adapter renders them.
 */
export { isFirecrawlProgressEvent, type FirecrawlProgressEvent } from './firecrawl-client';
