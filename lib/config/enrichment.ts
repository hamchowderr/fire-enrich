/**
 * Enrichment configuration
 */

export const ENRICHMENT_CONFIG = {
  /**
   * Number of rows to process concurrently
   * Higher values = faster processing but more API usage
   * Recommended: 2-5 for most use cases
   */
  CONCURRENT_ROWS: 10,

  /**
   * Rows processed at once by the Mastra engine (`ENRICH_ENGINE=mastra`).
   * Lower than the legacy value: each row already runs two research groups at
   * once, and a hosted-agent group holds a Firecrawl job for minutes.
   */
  MASTRA_CONCURRENT_ROWS: 5,

  /**
   * Delay between batches (milliseconds)
   * Helps prevent rate limiting
   */
  BATCH_DELAY_MS: 1000,
} as const;
