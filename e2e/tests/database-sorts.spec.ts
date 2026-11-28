import { expect, type Page, test } from '@playwright/test';

import { createDatabase, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

const TITLES = ['Beta', 'Alpha', 'Gamma'] as const;

/** A database with a date column and three rows, two of them on the same day. */
async function databaseWithDates(page: Page, baseURL: string | undefined): Promise<string> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const databaseId = await createDatabase(page, `Belege ${Date.now().toString(36)}`);
  await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });
  const headers = { origin: baseURL ?? '' };
  const property = await page.request.post(`/api/documents/${databaseId}/properties`, {
    headers,
    data: { type: 'DATE', name: 'Datum' },
  });
  expect(property.ok(), await property.text()).toBe(true);
  const { id: dateId } = (await property.json()) as { id: string };
  const days: Record<(typeof TITLES)[number], string> = {
    Beta: '2026-03-01',
    Alpha: '2026-03-01',
    Gamma: '2026-05-01',
  };
  for (const title of TITLES) {
    const response = await page.request.post(`/api/documents/${databaseId}/rows`, {
      headers,
      data: { title, values: [{ propertyId: dateId, value: days[title] }] },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.reload();
  await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(3, { timeout: 15_000 });
  return dateId;
}

/** The row titles from top to bottom. */
async function rowOrder(page: Page): Promise<string[]> {
  const texts = await page.locator('[data-testid^="database-row-"]').allInnerTexts();
  return texts.map((text) => TITLES.find((title) => text.includes(title)) ?? '?');
}

async function expectOrder(page: Page, order: readonly string[]): Promise<void> {
  await expect.poll(() => rowOrder(page), { timeout: 15_000 }).toEqual(order);
}

test.describe('sorting a database by several columns (issue #296)', () => {
  test('sorts from the headers, reorders the rules by keyboard and by dragging', async ({
    page,
    baseURL,
  }) => {
    const dateId = await databaseWithDates(page, baseURL);
    await expectOrder(page, ['Beta', 'Alpha', 'Gamma']);

    // By date, newest first, from the column's own menu ...
    await page.getByTestId(`property-menu-${dateId}`).click();
    await page.getByTestId(`column-sort-desc-${dateId}`).click();
    await expect(page.getByTestId(`column-sort-${dateId}`)).toHaveAttribute(
      'data-direction',
      'desc',
    );
    // ... then by name for the two rows on the same day: the second rule only
    // breaks the tie the first one left.
    await page.getByTestId('title-column-menu').click();
    await page.getByTestId('column-sort-asc-title').click();
    await expectOrder(page, ['Gamma', 'Alpha', 'Beta']);
    await expect(page.getByTestId('column-sort-title')).toHaveAccessibleName(
      'Sortiert aufsteigend, Stelle 2 von 2',
    );
    await expect(page.getByTestId('add-sort')).toHaveAccessibleName(
      'Sortierung bearbeiten: Datum absteigend, Name aufsteigend',
    );

    // The editor lists both rules in their priority order.
    await page.getByTestId('add-sort').click();
    await expect(page.getByTestId('sort-column-0')).toContainText('Datum');
    await expect(page.getByTestId('sort-column-1')).toContainText('Name');

    // Alt+Arrow up on the name's grip makes it the first rule.
    await page.getByTestId('sort-grip-1').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByTestId('sort-column-0')).toContainText('Name');
    await expect(page.getByTestId('sort-grip-0')).toBeFocused();
    await expect(page.getByText('Name steht jetzt an Stelle 1 von 2.')).toBeAttached();
    await expectOrder(page, ['Alpha', 'Beta', 'Gamma']);

    // Dragging the date's grip above it puts the date first again.
    const grip = page.getByTestId('sort-grip-1');
    const target = await page.getByTestId('sort-rule-0').boundingBox();
    const start = await grip.boundingBox();
    if (target === null || start === null) throw new Error('sort rules are not laid out');
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2, target.y + 2, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByTestId('sort-column-0')).toContainText('Datum');
    await expectOrder(page, ['Gamma', 'Alpha', 'Beta']);

    // The direction turns around per rule, in place.
    await page.getByTestId('sort-direction-0').click();
    await page.getByRole('option', { name: 'Aufsteigend' }).click();
    await expectOrder(page, ['Alpha', 'Beta', 'Gamma']);
    await page.getByTestId('sort-direction-1').click();
    await page.getByRole('option', { name: 'Absteigend' }).click();
    await expectOrder(page, ['Beta', 'Alpha', 'Gamma']);

    // Stored on the view: a reload keeps both rules in that order.
    await page.keyboard.press('Escape');
    await page.reload();
    await expectOrder(page, ['Beta', 'Alpha', 'Gamma']);
    await expect(page.getByTestId('add-sort')).toHaveAccessibleName(
      'Sortierung bearbeiten: Datum aufsteigend, Name absteigend',
    );

    // Removing the first rule leaves the second one deciding alone.
    await page.getByTestId('add-sort').click();
    await page.getByTestId('sort-remove-0').click();
    await expectOrder(page, ['Gamma', 'Beta', 'Alpha']);
  });

  test('fits the editor on a phone and reorders by touch', async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      storageState: storageStatePath('johanna'),
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await databaseWithDates(page, baseURL);
      await page.getByTestId('add-sort').tap();
      await page.getByTestId('sort-add-rule').tap();
      await page.getByTestId('sort-add-rule').tap();
      await expect(page.getByTestId('sort-column-0')).toContainText('Name');
      await expect(page.getByTestId('sort-column-1')).toContainText('Datum');

      const popover = page.locator('[data-slot="popover-content"]');
      const box = await popover.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 390).toBe(true);

      // A finger on the grip: pointer events of type touch, captured by the grip.
      const grip = await page.getByTestId('sort-grip-1').boundingBox();
      const first = await page.getByTestId('sort-rule-0').boundingBox();
      if (grip === null || first === null) throw new Error('sort rules are not laid out');
      const x = grip.x + grip.width / 2;
      const client = await context.newCDPSession(page);
      const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', y: number) =>
        client.send('Input.dispatchTouchEvent', {
          type,
          touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
        });
      await touch('touchStart', grip.y + grip.height / 2);
      for (const y of [grip.y, first.y + first.height / 2, first.y + 2]) {
        await touch('touchMove', y);
      }
      await touch('touchEnd', first.y + 2);
      await expect(page.getByTestId('sort-column-0')).toContainText('Datum');
    } finally {
      await context.close();
    }
  });
});
