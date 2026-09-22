import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizePlanNames, resolvePlannerProfile } from '@/lib/mastra/agents/planner';
import type { ResearchPlanType } from '@/lib/mastra/schemas';
import type { Profile } from '@/lib/profiles';

/**
 * The planner's profile selection and name normalisation. No model call:
 * the agent itself is exercised through the route in tests/api.
 */
const { getProfile, listProfiles } = vi.hoisted(() => ({
  getProfile: vi.fn<(id: string) => Promise<Profile | null>>(),
  listProfiles: vi.fn<() => Promise<Profile[]>>(),
}));

vi.mock('@/lib/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/profiles')>()),
  getProfile,
  listProfiles,
}));

function profile(id: string, name: string): Profile {
  return {
    id,
    name,
    business_summary: `${name} summary`,
    offer: `${name} offer`,
    audiences: [],
    default_field_hints: [],
    crm_defaults: {},
    models: {},
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
  };
}

const NEWEST = profile('newest', 'Example Co');
const CONFIGURED = profile('configured', 'Example Labs');

const DOLT_ENV = { DOLT_HOST: '127.0.0.1', DOLT_DATABASE: 'fire_enrich_test' } as const;

beforeEach(() => {
  Object.assign(process.env, DOLT_ENV);
  delete process.env.DEFAULT_PROFILE_ID;
  getProfile.mockImplementation(async (id) =>
    [NEWEST, CONFIGURED].find((candidate) => candidate.id === id) ?? null
  );
  listProfiles.mockResolvedValue([NEWEST, CONFIGURED]);
});

afterEach(() => {
  for (const key of Object.keys(DOLT_ENV)) delete process.env[key];
  delete process.env.DEFAULT_PROFILE_ID;
  vi.clearAllMocks();
});

describe('resolvePlannerProfile', () => {
  it('reads the requested profile', async () => {
    await expect(resolvePlannerProfile('configured')).resolves.toMatchObject({
      source: 'requested',
      profile: { name: 'Example Labs' },
    });
  });

  it('falls back to generic for an unknown requested id', async () => {
    await expect(resolvePlannerProfile('missing')).resolves.toMatchObject({ source: 'generic' });
  });

  it('uses DEFAULT_PROFILE_ID when no id is given', async () => {
    process.env.DEFAULT_PROFILE_ID = 'configured';

    await expect(resolvePlannerProfile()).resolves.toMatchObject({
      source: 'default',
      profile: { name: 'Example Labs' },
    });
  });

  it('uses the newest profile when no id and no default are set', async () => {
    await expect(resolvePlannerProfile()).resolves.toMatchObject({
      source: 'first',
      profile: { name: 'Example Co' },
    });
  });

  it('plans with a generic profile when none exist', async () => {
    listProfiles.mockResolvedValue([]);

    await expect(resolvePlannerProfile()).resolves.toMatchObject({ source: 'generic' });
  });

  it('plans with a generic profile when Dolt is not configured', async () => {
    for (const key of Object.keys(DOLT_ENV)) delete process.env[key];

    await expect(resolvePlannerProfile('configured')).resolves.toMatchObject({
      source: 'generic',
    });
    expect(getProfile).not.toHaveBeenCalled();
  });

  it('degrades to generic when the default lookup fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    listProfiles.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(resolvePlannerProfile()).resolves.toMatchObject({ source: 'generic' });
  });
});

describe('normalizePlanNames', () => {
  it('renames fields the way the UI does and follows the rename in groups', () => {
    const plan: ResearchPlanType = {
      fields: [
        field('SupportTeam', 'Support Team Size'),
        field('channels', 'Support Channels'),
        field('channels_again', 'Support Channels'),
      ],
      groups: [
        group('one', ['SupportTeam']),
        group('two', ['channels', 'channels_again']),
      ],
      interpretation: '',
    };

    const normalized = normalizePlanNames(plan);

    expect(normalized.fields.map((f) => f.name)).toEqual([
      'support_team_size',
      'support_channels',
      'support_channels_2',
    ]);
    expect(normalized.groups.map((g) => g.fieldNames)).toEqual([
      ['support_team_size'],
      ['support_channels', 'support_channels_2'],
    ]);
  });
});

function field(name: string, displayName: string): ResearchPlanType['fields'][number] {
  return { name, displayName, description: displayName, type: 'string', examples: [], strategy: 'search' };
}

function group(id: string, fieldNames: string[]): ResearchPlanType['groups'][number] {
  return {
    id,
    label: id,
    fieldNames,
    strategy: 'search',
    queries: ['{company}'],
    preferredSources: [],
    instructions: '',
  };
}
