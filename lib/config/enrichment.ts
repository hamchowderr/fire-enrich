/**
 * Enrichment configuration
 */

export const ENRICHMENT_CONFIG = {
  /**
   * Rows processed at once by the enrichRow workflow. Kept low: each row
   * already runs two research groups at once, and a hosted-agent group holds a
   * Firecrawl job for minutes.
   */
  MASTRA_CONCURRENT_ROWS: 5,

  /**
   * Delay between batches (milliseconds)
   * Helps prevent rate limiting
   */
  BATCH_DELAY_MS: 1000,
} as const;
