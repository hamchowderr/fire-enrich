/**
 * Request-context keys the enrich-row workflow sets for the identify and
 * research agents.
 *
 * Both agents resolve their model and (for research) their tools per call, from
 * these keys, so one registered agent serves every strategy and every model
 * override without an env var or a second registration.
 */
import type { ResearchGroupType } from '../schemas';

/** A gateway model id (`provider/model`) that overrides the `research` role default. */
export const RESEARCH_MODEL_KEY = 'researchModel';

/** The strategy of the group being researched; picks the research agent's tools. */
export const RESEARCH_STRATEGY_KEY = 'researchStrategy';

export type ResearchStrategy = ResearchGroupType['strategy'];

