import { expect, type Page, test } from '@playwright/test';

import { createDatabase, createPage, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

test.describe('databases', () => {
  test('creates a database, adds properties, rows, a filter and a sort', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    const title = `Aufgaben ${Date.now().toString(36)}`;
    await createDatabase(page, title);

    // A database opens with exactly one default view, auto-created.
    await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });

    await addProperty(page, 'Priorität', 'Zahl');
    await addProperty(page, 'Status', 'Auswahl');

    const statusHeader = page.locator('th', { hasText: 'Status' });
    await statusHeader.getByTestId(/^property-menu-/).click();
    await page.getByText('Optionen verwalten').click();
    await page.getByPlaceholder('Neue Option').fill('Erledigt');
    await page.getByLabel('Option hinzufügen').click();
    await page.keyboard.press('Escape');

    await page.getByTestId('add-row').click();
    await page.getByTestId('add-row').click();
    await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(2, { timeout: 15_000 });

    const rows = page.locator('[data-testid^="database-row-"]');
    await rows.nth(0).locator('input[type="number"]').fill('5');
    await rows.nth(0).locator('input[type="number"]').blur();
    await rows.nth(0).locator('button:has-text("Leer")').first().click();
    await page.locator('[data-slot="popover-content"]').getByRole('button', { name: 'Erledigt' }).click();

    await page.getByTestId('add-filter').click();
    await page.getByRole('combobox').first().click();
    await page.getByRole('option', { name: 'Priorität' }).click();
    await page.getByRole('combobox').nth(1).click();
    await page.getByRole('option', { name: 'größer als' }).click();
    await page.getByPlaceholder('Wert').fill('1');
    await page.getByRole('button', { name: 'Filter hinzufügen' }).click();

    // Only the row with priority 5 matches "greater than 1".
    await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(1, { timeout: 15_000 });
  });

  test('switches between Table, Board, Gallery and Calendar on the same data', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    const title = `Projekte ${Date.now().toString(36)}`;
    await createDatabase(page, title);
    await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });

    await addProperty(page, 'Status', 'Auswahl');
    const statusHeader = page.locator('th', { hasText: 'Status' });
    await statusHeader.getByTestId(/^property-menu-/).click();
    await page.getByText('Optionen verwalten').click();
    await page.getByPlaceholder('Neue Option').fill('Offen');
    await page.getByLabel('Option hinzufügen').click();
    await page.keyboard.press('Escape');

    await page.getByTestId('add-row').click();
    await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(1, { timeout: 15_000 });

    // Board: pick the grouping property, then the row shows up as a card.
    await page.getByTestId('add-view').click();
    await page.getByTestId('add-view-board').click();
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Status' }).click();
    await expect(page.getByText('Offen')).toBeVisible({ timeout: 15_000 });

    // Gallery: same row, as a card grid.
    await page.getByTestId('add-view').click();
    await page.getByTestId('add-view-gallery').click();
    await expect(page.getByText('Unbenannt')).toBeVisible({ timeout: 15_000 });

    // Calendar: no DATE property yet, so it asks for one instead of erroring.
    await page.getByTestId('add-view').click();
    await page.getByTestId('add-view-calendar').click();
    await expect(page.getByText('Wähle eine Datums-Eigenschaft')).toBeVisible({ timeout: 15_000 });

    // Back to Table: the same row is still there.
    await page.getByTestId(/^view-tab-/).first().click();
    await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(1, { timeout: 15_000 });
  });

  test('opens a row as a normal, editable page', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    const title = `Notizen ${Date.now().toString(36)}`;
    await createDatabase(page, title);
    await expect(page.getByTestId('add-row')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('add-row').click();

    const row = page.locator('[data-testid^="database-row-"]').first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('link').click();

    // The row is a real page: it has its own editable title and collaborative editor.
    await expect(page.getByTestId('document-title')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="database-shell"]')).toHaveCount(0);
  });

  test('embeds a database live inside a normal page', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    const databaseTitle = `Eingebettet ${Date.now().toString(36)}`;
    const databaseId = await createDatabase(page, databaseTitle);

    const pageTitle = `Notizseite ${Date.now().toString(36)}`;
    await createPage(page, pageTitle);
    await page.getByTestId('editor-surface').click();

    await page.keyboard.type('/datenbank');
    await expect(page.getByTestId('slash-option-database-embed')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');

    await page.getByPlaceholder('Datenbank suchen …').fill(databaseTitle);
    await page.getByTestId(`database-prompt-option-${databaseId}`).click();

    const embed = page.locator('.exocortex-database-embed');
    await expect(embed).toBeVisible({ timeout: 15_000 });
    await expect(embed).toContainText(databaseTitle);

    // Fully interactive: a row can be added and edited without leaving the page.
    await embed.getByTestId('add-row').click();
    await expect(embed.locator('[data-testid^="database-row-"]')).toHaveCount(1, {
      timeout: 15_000,
    });

    // "In eigener Seite öffnen" leads to the same database, opened as its own page.
    await embed.getByRole('link', { name: 'In eigener Seite öffnen' }).click();
    await page.waitForURL(new RegExp(`/seite/${databaseId}$`), { timeout: 15_000 });
    await expect(page.getByTestId('database-shell')).toBeVisible({ timeout: 15_000 });
  });
});

async function addProperty(page: Page, name: string, typeLabel: string): Promise<void> {
  await page.getByTestId('add-property').click();
  await page.getByPlaceholder('Name der Eigenschaft').fill(name);
  await page.getByRole('combobox').click();
  await page.getByRole('option', { name: typeLabel, exact: true }).click();
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click();
  await expect(page.locator('th', { hasText: name })).toBeVisible({ timeout: 15_000 });
}
