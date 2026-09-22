import { describe, expect, it } from 'vitest';

import {
  hasPlaceholder,
  planIssues,
  ResearchPlan,
  type ResearchPlanType,
} from '@/lib/mastra/schemas';

import plannerFixtures from '../../fixtures/planner-plan.json';

/** The plan the AIMock fixture serves, parsed from its string content. */
const fixturePlan: unknown = JSON.parse(plannerFixtures.fixtures[0].response.content);

function validPlan(): ResearchPlanType {
  return ResearchPlan.parse(structuredClone(fixturePlan));
}

describe('ResearchPlan', () => {
  it('accepts the fixture plan', () => {
    expect(ResearchPlan.safeParse(fixturePlan).success).toBe(true);
  });

  it('rejects a field with an unknown type', () => {
    const plan = validPlan() as unknown as { fields: Array<{ type: string }> };
    plan.fields[0].type = 'date';

    expect(ResearchPlan.safeParse(plan).success).toBe(false);
  });

  it('rejects a field with an unknown strategy', () => {
    const plan = validPlan() as unknown as { fields: Array<{ strategy: string }> };
    plan.fields[0].strategy = 'guess';

    expect(ResearchPlan.safeParse(plan).success).toBe(false);
  });

  it('rejects a group with no queries', () => {
    const plan = validPlan();
    plan.groups[0].queries = [];

    expect(ResearchPlan.safeParse(plan).success).toBe(false);
  });

  it('requires every property, including the empty-able ones', () => {
    const plan = validPlan() as unknown as { fields: Array<Record<string, unknown>> };
    delete plan.fields[0].examples;

    expect(ResearchPlan.safeParse(plan).success).toBe(false);
  });
});

describe('hasPlaceholder', () => {
  it.each([
    ['{company} pricing page', true],
    ['site:{domain} careers', true],
    ['{company} site:{domain}', true],
    ['acme pricing page', false],
    ['{name} pricing', false],
  ])('%s → %s', (query, expected) => {
    expect(hasPlaceholder(query)).toBe(expected);
  });

  it('holds for every query in the fixture plan', () => {
    const queries = validPlan().groups.flatMap((group) => group.queries);

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(hasPlaceholder)).toBe(true);
  });
});

describe('planIssues', () => {
  it('finds nothing wrong with the fixture plan', () => {
    expect(planIssues(validPlan())).toEqual([]);
  });

  it('reports a plan with a single group', () => {
    const plan = validPlan();
    plan.groups[0].fieldNames.push(...plan.groups[1].fieldNames);
    plan.groups = [plan.groups[0]];

    expect(planIssues(plan)).toEqual(['A plan needs at least two research groups']);
  });

  it('reports a query without a placeholder', () => {
    const plan = validPlan();
    plan.groups[0].queries.push('customer support software');

    expect(planIssues(plan)).toEqual([
      'Group "support-setup" query has no placeholder: "customer support software"',
    ]);
  });

  it('reports references to unknown fields and fields left out of every group', () => {
    const plan = validPlan();
    plan.groups[1].fieldNames = ['support_team_size', 'headcount'];

    expect(planIssues(plan)).toEqual([
      'Group "support-team" references unknown field "headcount"',
      'Field "open_support_roles" is not in any research group',
    ]);
  });

  it('reports duplicate field names and group ids', () => {
    const plan = validPlan();
    plan.fields.push({ ...plan.fields[0] });
    plan.groups[1].id = plan.groups[0].id;

    expect(planIssues(plan)).toEqual([
      'Duplicate field name "support_channels"',
      'Duplicate group id "support-setup"',
    ]);
  });
});
