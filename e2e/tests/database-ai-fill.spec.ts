import { expect, type Page, test } from '@playwright/test';

import { createDatabase, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * A database with a text column and two rows, one of them with a value in it,
 * made through the API. Nothing here starts a batch: every count below is a
 * dry run, so the test never pays for a model call.
 */
async function databaseWithTextColumn(
  page: Page,
  baseURL: string | undefined,
): Promise<{ propertyId: string }> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const databaseId = await createDatabase(page, `KI-Spalte ${Date.now().toString(36)}`);
  await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });
  const headers = { origin: baseURL ?? '' };
  const property = await page.request.post(`/api/documents/${databaseId}/properties`, {
    headers,
    data: { type: 'TEXT', name: 'Kurzfassung' },
  });
  expect(property.ok(), await property.text()).toBe(true);
  const { id: propertyId } = (await property.json()) as { id: string };
  for (const [title, value] of [
    ['Leer', null],
    ['Voll', 'Von Hand geschrieben'],
  ] as const) {
    const response = await page.request.post(`/api/documents/${databaseId}/rows`, {
      headers,
      data: { title, values: value === null ? [] : [{ propertyId, value }] },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.reload();
  await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(2, { timeout: 15_000 });
  return { propertyId };
}

test.describe('AI columns (issue #237)', () => {
  test('gives a column an instruction, counts before filling and offers the selection', async ({
    page,
    baseURL,
  }) => {
    const { propertyId } = await databaseWithTextColumn(page, baseURL);

    // The column menu sets the instruction up; the default preset needs no words.
    await page.getByTestId(`property-menu-${propertyId}`).click();
    await page.getByTestId(`property-ai-configure-${propertyId}`).click();
    const config = page.getByTestId('ai-config-dialog');
    await expect(config.getByTestId('ai-config-preset')).toHaveText(/Zusammenfassung/);
    await expect(config.getByTestId('ai-config-auto')).toHaveText(/Nie, nur auf Anfrage/);

    // An own instruction without words cannot be saved.
    await config.getByTestId('ai-config-preset').click();
    await page.getByTestId('ai-config-preset-custom').click();
    await expect(config.getByTestId('ai-config-problem')).toBeVisible();
    await expect(config.getByTestId('ai-config-save')).toBeDisabled();
    await config.getByTestId('ai-config-instruction').fill('Ein Satz, worum es geht.');
    await expect(config.getByTestId('ai-config-save')).toBeEnabled();
    await config.getByTestId('ai-config-save').click();
    await expect(config).toHaveCount(0);
    await expect(page.getByTestId(`property-ai-marker-${propertyId}`)).toBeVisible({
      timeout: 15_000,
    });

    // Filling the column asks first: one empty cell by default, two when a
    // person's value may be replaced. Cancelling starts nothing.
    await page.getByTestId(`property-menu-${propertyId}`).click();
    await page.getByTestId(`property-ai-fill-${propertyId}`).click();
    const fill = page.getByTestId('ai-fill-dialog');
    await expect(fill.getByTestId('ai-fill-preview')).toContainText('Eine Zelle wird ausgefüllt', {
      timeout: 15_000,
    });
    await expect(fill.getByTestId('ai-fill-preview')).toContainText('Eine Zelle mit Wert bleibt');
    await fill.getByTestId('ai-fill-mode').click();
    await page.getByTestId('ai-fill-mode-replace_all').click();
    await expect(fill.getByTestId('ai-fill-preview')).toContainText('2 Zellen werden ausgefüllt', {
      timeout: 15_000,
    });
    await fill.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(fill).toHaveCount(0);
    await expect(page.getByTestId('ai-fill-progress')).toHaveCount(0);

    // An empty cell of the column offers to be filled; a cell with a value does not.
    const empty = page.locator('[data-testid^="database-row-"]', { hasText: 'Leer' });
    const full = page.locator('[data-testid^="database-row-"]', { hasText: 'Voll' });
    await expect(
      empty.locator(`[data-testid^="ai-cell-"][data-testid$="-${propertyId}"][data-state="offer"]`),
    ).toHaveCount(1);
    await expect(
      full.locator(`[data-testid^="ai-cell-"][data-testid$="-${propertyId}"][data-state="offer"]`),
    ).toHaveCount(0);

    // A selection can be filled from the bar.
    await empty.hover();
    await empty.getByTestId('row-select').click();
    await page.getByTestId('selection-ai-fill').click();
    await page.getByTestId(`selection-ai-fill-${propertyId}`).click();
    await expect(page.getByTestId('ai-fill-dialog')).toContainText('ausgewählten Zeile');
    await page.getByTestId('ai-fill-dialog').getByRole('button', { name: 'Abbrechen' }).click();
    await page.keyboard.press('Escape');

    // Removing the instruction takes the mark away.
    await page.getByTestId(`property-menu-${propertyId}`).click();
    await page.getByTestId(`property-ai-configure-${propertyId}`).click();
    await page.getByTestId('ai-config-remove').click();
    await expect(page.getByTestId(`property-ai-marker-${propertyId}`)).toHaveCount(0, {
      timeout: 15_000,
    });
  });
});
