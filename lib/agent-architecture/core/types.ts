import { z } from 'zod';

// Email context that flows through all agents
export const EmailContext = z.object({
  email: z.string().email(),
  domain: z.string(),
  companyDomain: z.string().optional(),
  personalName: z.string().optional(),
  companyNameGuess: z.string().optional(),
  isPersonalEmail: z.boolean(),
});

export type EmailContext = z.infer<typeof EmailContext>;

// Final enrichment result
export interface EnrichmentResult {
  field: string;
  value: string | number | boolean | string[] | null;
  confidence: number;
  source?: string;
  sourceContext?: Array<{
    url: string;
    snippet: string;
  }>;
}

export interface RowEnrichmentResult {
  rowIndex: number;
  originalData: Record<string, string>;
  enrichments: Record<string, EnrichmentResult>;
  status: 'pending' | 'processing' | 'completed' | 'error' | 'skipped';
  error?: string;
}