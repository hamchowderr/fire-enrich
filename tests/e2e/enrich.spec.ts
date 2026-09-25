/**
 * The user path end to end, in a real browser, with no real keys: upload a
 * CSV, ask for fields in plain language, accept two of the suggestions, start,
 * and watch the first row fill in with a value and the source it came from.
 *
 * Everything asserted here is what the page rendered from the `/api/enrich`
 * event stream; the test never reads the API itself. The models answer from
 * AIMock (`fixtures/planner-plan.json` for the plan, `fixtures/e2e-enrich.json`
 * for identify and research) and Firecrawl from the stub serving
 * `tests/fixtures/firecrawl/`, whose request log is checked at the end.
 *
 * The CSV (`tests/e2e/sample.csv`) has two rows: Eric Ciarla at firecrawl.dev,
 * the one company in `public/sample-data.csv` the Firecrawl recordings
 * describe, and a personal-mailbox row the skip list turns away before any
 * model call.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { FIRECRAWL_STUB_LOG } from './ports';

const plannerFixtures = JSON.parse(readFileSync(path.resolve('fixtures/planner-plan.json'), 'utf8')) as {
  fixtures: Array<{ match: { userMessage: string; systemMessage: string } }>;
};
/** The goal the generic-profile planner fixture answers. */
const GOAL = plannerFixtures.fixtures.find((fixture) => fixture.match.systemMessage === 'uses a generic profile')!
  .match.userMessage;

const FAVICON = readFileSync(path.resolve('public/favicon.png'));

test('upload, accept suggested fields, enrich, see the first row with its source', async ({ page }) => {
  // Nothing leaves the machine: the source favicons the activity feed asks
  // Google for are answered locally, and any other outside request fails.
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) =>
      route.request().url().startsWith('https://www.google.com/s2/favicons')
        ? route.fulfill({ status: 200, contentType: 'image/png', body: FAVICON })
        : route.abort()
  );

  await page.goto('/fire-enrich');

  // Upload.
  await expect(page.getByText('Drag & drop your CSV file here')).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(path.resolve('tests/e2e/sample.csv'));

  // Step 1: the email column is detected; confirm it.
  await expect(page.getByRole('cell', { name: 'eric@firecrawl.dev' })).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  // Step 2: drop the preset defaults so the run is exactly the planned fields.
  for (const preset of ['Company Name', 'Company Description', 'Industry']) {
    await page.getByRole('button', { name: preset, exact: true }).click();
  }
  await expect(page.getByText('0 / 10')).toBeVisible();

  await page.getByRole('button', { name: 'Add with natural language' }).click();
  await page.getByPlaceholder(/CEO name, company mission statement/).fill(GOAL);
  await page.getByRole('button', { name: 'Generate Fields' }).click();

  // Accept the two suggestions researched by search (the plan's other group
  // needs a browser session).
  const suggestion = (name: string) => page.locator('.suggested-field-card', { hasText: name });
  for (const name of ['Sells To Businesses', 'Target Customer']) {
    await suggestion(name).getByRole('button', { name: 'Accept' }).click();
  }
  await expect(page.getByText('2 / 10')).toBeVisible();

  await page.getByRole('button', { name: 'Start Enrichment' }).click();

  // The results table, driven by the event stream.
  const table = page.locator('table').filter({ has: page.getByRole('columnheader', { name: 'Target Customer' }) });
  const firstRow = table.locator('tbody tr').first();
  await expect(firstRow).toContainText('eric@firecrawl.dev');

  const headers = await table.locator('thead th').allInnerTexts();
  const cell = (field: string) => firstRow.locator('td').nth(headers.indexOf(field));

  await expect(cell('Target Customer')).toHaveText('Teams building AI agents', { timeout: 60_000 });
  await expect(cell('Sells To Businesses')).toHaveText('✓');

  // The second row was skipped, not enriched.
  await expect(table.locator('tbody tr').nth(1)).toContainText('Skipped');
  await expect(page.getByText('Enrichment Complete')).toBeVisible();

  // The source of the value: the evidence line in the first row's activity,
  // with the site's icon. Completed rows auto-collapse, so open it if needed.
  const activityRow = page.locator('div.border.rounded-md', {
    has: page.getByRole('button', { name: /^Row 1\b/ }),
  });
  const evidence = activityRow.locator('div.flex.items-start', {
    hasText: 'target_customer: evidence from firecrawl.dev',
  });
  const sourceIcon = evidence.getByRole('img', { name: 'www.firecrawl.dev favicon' });

  await expect(async () => {
    if (!(await sourceIcon.isVisible())) await activityRow.getByRole('button', { name: /^Row 1\b/ }).click();
    await expect(sourceIcon).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(sourceIcon).toHaveJSProperty('complete', true);
  expect(await sourceIcon.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);

  await page.screenshot({ path: test.info().outputPath('enriched-first-row.png'), fullPage: true });

  // The tools reached Firecrawl through the stub.
  const stubRequests = readFileSync(FIRECRAWL_STUB_LOG, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { method: string; path: string; status: number; query?: string });
  expect(stubRequests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: 'POST', path: '/v2/search', status: 200, query: 'firecrawl.dev company' }),
      expect.objectContaining({ method: 'POST', path: '/v2/search', status: 200, query: 'Firecrawl customers' }),
    ])
  );
});
