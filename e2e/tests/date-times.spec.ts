import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import { createDatabase, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Issue #255: a time is shown in the reader's zone and on the reader's clock,
// typed back on the same clock, and stored as the UTC instant; a whole day
// never moves. The suite's browser is German in Europe/Berlin.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

async function setTimeFormat(
  request: APIRequestContext,
  baseURL: string | undefined,
  timeFormat: 'auto' | '24h' | '12h',
): Promise<void> {
  const response = await request.patch('/api/me/preferences', {
    data: { timeFormat },
    headers: { origin: baseURL ?? '' },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

/** `Intl` writes a narrow no-break space before "PM"; the test reads plain spaces. */
function spaced(text: string): string {
  return text.replace(/[  ]/g, ' ');
}

interface Fixture {
  databaseId: string;
  winterRowId: string;
  summerRowId: string;
  meetingId: string;
}

async function buildFixture(page: Page, baseURL: string | undefined): Promise<Fixture> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const databaseId = await createDatabase(page, `Termine ${Date.now().toString(36)}`);
  await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });
  const headers = { origin: baseURL ?? '' };

  const create = async (data: Record<string, unknown>): Promise<string> => {
    const response = await page.request.post(`/api/documents/${databaseId}/properties`, {
      headers,
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { id: string }).id;
  };
  const meetingId = await create({
    type: 'DATE',
    name: 'Termin',
    config: { includeTime: true, isRange: true, timeZone: null },
  });
  const dueId = await create({ type: 'DATE', name: 'Fällig', config: { includeTime: false } });
  await create({
    type: 'FORMULA',
    name: 'Tag danach',
    config: { expression: 'dateAdd(prop("Fällig"); 1)' },
  });

  const row = async (title: string, values: unknown[]): Promise<string> => {
    const response = await page.request.post(`/api/documents/${databaseId}/rows`, {
      headers,
      data: { title, values },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { document: { id: string } }).document.id;
  };
  // 11:00 UTC on 26 November is noon in Berlin (CET), 10:00 UTC on 15 July
  // is noon too (CEST): both rows have to read 12:00. The winter span ends at
  // 16:00, late enough that moving its start to 14:30 keeps it a span.
  const winterRowId = await row('A Winter', [
    {
      propertyId: meetingId,
      value: { start: '2026-11-26T11:00:00.000Z', end: '2026-11-26T15:00:00.000Z', allDay: false },
    },
    { propertyId: dueId, value: '2026-02-27' },
  ]);
  const summerRowId = await row('B Sommer', [
    {
      propertyId: meetingId,
      value: { start: '2026-07-15T10:00:00.000Z', end: null, allDay: false },
    },
  ]);
  return { databaseId, winterRowId, summerRowId, meetingId };
}

async function storedStart(page: Page, rowId: string, propertyId: string): Promise<string | null> {
  const response = await page.request.get(`/api/documents/${rowId}/row`);
  const body = (await response.json()) as {
    row: { values: { propertyId: string; value: { start: string } | null }[] } | null;
  };
  return body.row?.values.find((value) => value.propertyId === propertyId)?.value?.start ?? null;
}

test.describe('times in a database (issue #255)', () => {
  test.afterEach(async ({ request, baseURL }) => {
    await setTimeFormat(request, baseURL, 'auto');
  });

  test('reads a time on the reader clock and stores what was typed as UTC', async ({
    page,
    baseURL,
  }) => {
    const fixture = await buildFixture(page, baseURL);
    await page.reload();
    const rows = page.locator('[data-testid^="database-row-"]');
    await expect(rows).toHaveCount(2, { timeout: 15_000 });
    const winter = rows.filter({ hasText: 'A Winter' });
    const summer = rows.filter({ hasText: 'B Sommer' });
    const winterStart = winter.getByRole('textbox', { name: 'Beginn, Uhrzeit' });
    const summerStart = summer.getByRole('textbox', { name: 'Beginn, Uhrzeit' });

    // The language's clock: German writes 24 hours, in both seasons.
    await expect(winterStart).toHaveValue('12:00');
    await expect(winter.getByRole('textbox', { name: 'Ende, Uhrzeit' })).toHaveValue('16:00');
    await expect(summerStart).toHaveValue('12:00');
    // A whole day stays the day: the formula reads 28 February, without a time.
    await expect(winter.getByTestId('readonly-cell')).toHaveText('28.02.2026');

    // The account's clock wins over the language's.
    await setTimeFormat(page.request, baseURL, '12h');
    await page.reload();
    await expect(winterStart).toHaveValue(/^12:00\sPM$/);
    expect(spaced(await summerStart.inputValue())).toBe('12:00 PM');
    // The wider 12-hour time wraps under its day instead of spilling over
    // the next column.
    const cell = page.locator('td').filter({ has: winterStart });
    const [cellBox, fieldBox] = await Promise.all([cell.boundingBox(), winterStart.boundingBox()]);
    expect(fieldBox!.x + fieldBox!.width).toBeLessThanOrEqual(cellBox!.x + cellBox!.width + 1);

    // Typed on any clock, stored as the instant: 14:30 in winter is 13:30 UTC,
    // 2:30 pm in summer is 12:30 UTC.
    await winterStart.fill('14:30');
    await winterStart.press('Enter');
    await expect
      .poll(() => storedStart(page, fixture.winterRowId, fixture.meetingId))
      .toBe('2026-11-26T13:30:00.000Z');
    await summerStart.fill('2:30 pm');
    await summerStart.press('Tab');
    await expect
      .poll(() => storedStart(page, fixture.summerRowId, fixture.meetingId))
      .toBe('2026-07-15T12:30:00.000Z');

    // Back to 24 hours, the round trip reads what was typed.
    await setTimeFormat(page.request, baseURL, '24h');
    await page.reload();
    await expect(winterStart).toHaveValue('14:30');
    await expect(summerStart).toHaveValue('14:30');

    // Something that is not a time puts the last value back.
    await winterStart.fill('25:99');
    await winterStart.press('Tab');
    await expect(winterStart).toHaveValue('14:30');
    expect(await storedStart(page, fixture.winterRowId, fixture.meetingId)).toBe(
      '2026-11-26T13:30:00.000Z',
    );
  });

  test('is chosen on the language page, with an example per clock', async ({ page }) => {
    await page.goto('/einstellungen/sprache');
    await expect(page.getByRole('heading', { name: 'Sprache und Uhrzeit' })).toBeVisible();
    await page.getByTestId('time-format').click();
    await page.getByRole('option', { name: /^12 Stunden/ }).click();
    await expect
      .poll(async () => (await page.request.get('/api/me/preferences')).json())
      .toMatchObject({ timeFormat: '12h' });
    expect(spaced((await page.getByTestId('time-format').textContent()) ?? '')).toContain(
      '12 Stunden (02:30 PM)',
    );
  });
});
