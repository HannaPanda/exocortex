import { expect, type Page, test } from '@playwright/test';

import { createDatabase, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/** A database with a checkbox column and four rows, made through the API. */
async function databaseWithRows(
  page: Page,
  baseURL: string | undefined,
): Promise<{ databaseId: string; propertyId: string }> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const databaseId = await createDatabase(page, `Zeilen ${Date.now().toString(36)}`);
  await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });
  const headers = { origin: baseURL ?? '' };
  const property = await page.request.post(`/api/documents/${databaseId}/properties`, {
    headers,
    data: { type: 'CHECKBOX', name: 'Erledigt' },
  });
  expect(property.ok(), await property.text()).toBe(true);
  const { id: propertyId } = (await property.json()) as { id: string };
  for (const title of ['Eins', 'Zwei', 'Drei', 'Vier']) {
    const response = await page.request.post(`/api/documents/${databaseId}/rows`, {
      headers,
      data: { title, values: [] },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.reload();
  await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(4, { timeout: 15_000 });
  return { databaseId, propertyId };
}

function rowNamed(page: Page, title: string) {
  return page.locator('[data-testid^="database-row-"]', { hasText: title });
}

test.describe('row actions and selection (issue #244)', () => {
  test('selects a range, sets a value for all, duplicates and trashes with a question', async ({
    page,
    baseURL,
  }) => {
    const { propertyId } = await databaseWithRows(page, baseURL);
    const rows = page.locator('[data-testid^="database-row-"]');

    // Nothing selected: the checkboxes wait for the pointer, the bar is absent.
    const first = rowNamed(page, 'Eins').getByTestId('row-select');
    await expect(first).toHaveCSS('opacity', '0');
    await expect(page.getByTestId('row-selection-bar')).toHaveCount(0);

    // One click, then Shift+click three rows further: a range of three.
    await rowNamed(page, 'Eins').hover();
    await first.click();
    await expect(page.getByTestId('selection-count')).toHaveText('1 ausgewählt');
    await expect(rowNamed(page, 'Vier').getByTestId('row-select')).toHaveCSS('opacity', '1');
    await rowNamed(page, 'Drei')
      .getByTestId('row-select')
      .click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('selection-count')).toHaveText('3 ausgewählt');
    await expect(rowNamed(page, 'Zwei')).toHaveAttribute('data-state', 'selected');
    await expect(rowNamed(page, 'Vier')).not.toHaveAttribute('data-state', 'selected');

    // One value for the three rows, in one go.
    await page.getByTestId('selection-set-value').click();
    await page.getByTestId(`selection-property-${propertyId}`).click();
    const dialog = page.getByTestId('selection-value-dialog');
    await dialog.getByRole('checkbox').click();
    await dialog.getByTestId('selection-value-done').click();
    for (const title of ['Eins', 'Zwei', 'Drei']) {
      await expect(
        rowNamed(page, title).getByRole('checkbox', { name: 'Kontrollkästchen' }),
      ).toBeChecked({ timeout: 15_000 });
    }
    await expect(
      rowNamed(page, 'Vier').getByRole('checkbox', { name: 'Kontrollkästchen' }),
    ).not.toBeChecked();

    // Duplicating puts a copy below each row and keeps the value.
    await page.getByTestId('selection-duplicate').click();
    await expect(rows).toHaveCount(7, { timeout: 15_000 });
    await expect(rowNamed(page, 'Zwei')).toHaveCount(2);

    // Escape lets go.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('row-selection-bar')).toHaveCount(0);

    // Two rows into the trash: asked first, and cancelling changes nothing.
    await rowNamed(page, 'Vier').hover();
    await rowNamed(page, 'Vier').getByTestId('row-select').click();
    await rowNamed(page, 'Eins').first().getByTestId('row-select').click();
    await page.getByTestId('selection-trash').click();
    await page.getByTestId('destructive-cancel').click();
    await expect(rows).toHaveCount(7);
    await page.getByTestId('selection-trash').click();
    await page.getByTestId('destructive-confirm-button').click();
    await expect(rows).toHaveCount(5, { timeout: 15_000 });
    await expect(rowNamed(page, 'Vier')).toHaveCount(0);
    await expect(page.getByTestId('row-selection-bar')).toHaveCount(0);
  });

  test('opens the row menu from the keyboard and acts on its own row', async ({
    page,
    baseURL,
  }) => {
    await databaseWithRows(page, baseURL);
    const rows = page.locator('[data-testid^="database-row-"]');

    // The checkbox takes Space; the handle opens its menu with Enter.
    const checkbox = rowNamed(page, 'Zwei').getByTestId('row-select');
    await checkbox.focus();
    await expect(checkbox).toHaveCSS('opacity', '1');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('selection-count')).toHaveText('1 ausgewählt');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('row-selection-bar')).toHaveCount(0);

    const handle = rowNamed(page, 'Drei').getByTestId('row-handle');
    await handle.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByTestId('row-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Öffnen',
      'Als Seite öffnen',
      'Link kopieren',
      'Duplizieren',
      'Verschieben',
      'In den Papierkorb',
    ]);
    await menu.getByTestId('row-duplicate').click();
    await expect(rowNamed(page, 'Drei')).toHaveCount(2, { timeout: 15_000 });

    // A single row goes without a question; the trash brings it back.
    await rowNamed(page, 'Eins').hover();
    await rowNamed(page, 'Eins').getByTestId('row-handle').click();
    await page.getByTestId('row-trash').click();
    await expect(rowNamed(page, 'Eins')).toHaveCount(0, { timeout: 15_000 });
    await expect(rows).toHaveCount(4);

    // "Öffnen" is the sheet, a click in a cell still edits the cell.
    await rowNamed(page, 'Zwei').hover();
    await rowNamed(page, 'Zwei').getByTestId('row-handle').click();
    await page.getByTestId('row-open-peek').click();
    await expect(page.getByTestId('row-peek')).toBeVisible();
  });
});
