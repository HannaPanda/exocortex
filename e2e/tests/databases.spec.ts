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
    await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(2, {
      timeout: 15_000,
    });

    const rows = page.locator('[data-testid^="database-row-"]');
    await rows.nth(0).locator('input[type="number"]').fill('5');
    await rows.nth(0).locator('input[type="number"]').blur();
    await rows.nth(0).locator('button:has-text("Leer")').first().click();
    await page
      .locator('[data-slot="popover-content"]')
      .getByRole('button', { name: 'Erledigt' })
      .click();

    await page.getByTestId('add-filter').click();
    await page.getByTestId('filter-property').click();
    await page.getByRole('option', { name: 'Priorität' }).click();
    await page.getByTestId('filter-operator').click();
    await page.getByRole('option', { name: 'größer als' }).click();
    await page.getByPlaceholder('Wert').fill('1');
    await page.getByRole('button', { name: 'Filter hinzufügen' }).click();

    // Only the row with priority 5 matches "greater than 1".
    await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(1, {
      timeout: 15_000,
    });

    await page.getByLabel('Filter entfernen').click();

    // A select filter is picked by label and stored by option id; the chip has
    // to read back the label, never the id.
    await page.getByTestId('add-filter').click();
    await page.getByTestId('filter-property').click();
    await page.getByRole('option', { name: 'Status' }).click();
    // The trigger has to show the label too, not the id behind it.
    await expect(page.getByTestId('filter-property')).toContainText('Status');
    await page.getByTestId('filter-value').click();
    await page.getByRole('option', { name: 'Erledigt' }).click();
    await page.getByRole('button', { name: 'Filter hinzufügen' }).click();

    await expect(page.getByText('Status ist Erledigt')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(1, {
      timeout: 15_000,
    });
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
    await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(1, {
      timeout: 15_000,
    });

    // Board: pick the grouping property, then the row shows up as a card.
    await page.getByTestId('add-view').click();
    await page.getByTestId('add-view-board').click();
    await page.getByTestId('board-group-by').click();
    await page.getByRole('option', { name: 'Status' }).click();
    await expect(page.getByText('Offen')).toBeVisible({ timeout: 15_000 });

    // Gallery: same row, as a card grid.
    await page.getByTestId('add-view').click();
    await page.getByTestId('add-view-gallery').click();
    // Scoped to the database: the sidebar tree also contains pages called
    // "Unbenannte Seite", which `getByText` would match too.
    await expect(
      page.getByTestId('database-shell').getByRole('link', { name: 'Unbenannt', exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    // Calendar: no DATE property yet, so it asks for one instead of erroring.
    await page.getByTestId('add-view').click();
    await page.getByTestId('add-view-calendar').click();
    await expect(page.getByText('Noch kein Datum gewählt')).toBeVisible({ timeout: 15_000 });

    // Back to Table: the same row is still there. By name, not by position --
    // the tab order follows the views' order keys.
    await page.getByRole('tab', { name: 'Tabelle' }).click();
    await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(1, {
      timeout: 15_000,
    });

    // Deleting a view asks first, and the ⋯ beside the tabs reaches it
    // without a right click. Cancel keeps it, confirm removes it.
    await page.getByRole('tab', { name: 'Galerie' }).click();
    await page.getByTestId('view-actions').click();
    await page.getByRole('menuitem', { name: 'Ansicht löschen' }).click();
    await expect(page.getByTestId('destructive-confirm')).toBeVisible();
    await page.getByTestId('destructive-cancel').click();
    await expect(page.getByRole('tab', { name: 'Galerie' })).toBeVisible();
    await page.getByTestId('view-actions').click();
    await page.getByRole('menuitem', { name: 'Ansicht löschen' }).click();
    await page.getByTestId('destructive-confirm-button').click();
    await expect(page.getByRole('tab', { name: 'Galerie' })).toHaveCount(0, { timeout: 15_000 });
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

  test('keeps a value longer than its column reachable', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    const title = `Langtext ${Date.now().toString(36)}`;
    await createDatabase(page, title);
    await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });
    await addProperty(page, 'Notiz', 'Text');
    await page.getByTestId('add-row').click();

    const row = page.locator('[data-testid^="database-row-"]').first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // A value far longer than any column: it has to survive the round trip and
    // stay readable, which is the whole point of the cell overlay.
    const long = `Zeile eins mit sehr viel Text. ${'Nachtrag '.repeat(30)}Ende.`;
    await row.getByTestId('cell-expand').click();
    await page.locator('[data-slot="popover-content"]').getByRole('textbox').fill(long);
    await page.keyboard.press('Escape');

    await expect(row.getByTestId('cell-expand')).toHaveText(long, { timeout: 15_000 });

    // Row height is a clamp, not a limit: switching to "Hoch" shows more of the
    // same value without changing it.
    await page.getByTestId('view-options').click();
    await page.getByTestId('row-height-tall').click();
    await page.keyboard.press('Escape');
    await expect(row.getByTestId('cell-expand')).toHaveText(long, { timeout: 15_000 });

    // The row sheet is the second way to the same value.
    await row.getByTestId('open-row-peek').click();
    const peek = page.getByTestId('row-peek');
    await expect(peek).toBeVisible({ timeout: 15_000 });
    await expect(peek.getByText('Notiz', { exact: true })).toBeVisible();
    await expect(peek.getByTestId('cell-expand')).toHaveText(long);
    await page.keyboard.press('Escape');

    // Hiding the column hides it from the table, not from the data.
    await page.getByTestId('view-options').click();
    await page.locator('[data-slot="popover-content"]').getByText('Notiz', { exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('th', { hasText: 'Notiz' })).toHaveCount(0, { timeout: 15_000 });

    await page.reload();
    await expect(page.locator('th', { hasText: 'Notiz' })).toHaveCount(0, { timeout: 15_000 });
  });

  test('changes the width of a page and remembers it', async ({ page }) => {
    // Wide enough that the reading measure is actually narrower than the
    // available space: with both panels open at 1280, it is not, and every
    // layout would measure the same.
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    await createPage(page, `Breite ${Date.now().toString(36)}`);
    await expect(page.getByTestId('document-title')).toBeVisible({ timeout: 15_000 });

    const body = page.locator('.exocortex-page');
    await expect(body).toHaveAttribute('data-layout', 'narrow', { timeout: 15_000 });
    const narrowWidth = (await body.boundingBox())?.width ?? 0;

    await page.getByTestId('document-actions').click();
    await page.getByTestId('open-page-properties').click();
    await page.getByTestId('layout-full').click();
    await page.getByTestId('save-page-properties').click();

    await expect(body).toHaveAttribute('data-layout', 'full', { timeout: 15_000 });
    const fullWidth = (await body.boundingBox())?.width ?? 0;
    expect(fullWidth).toBeGreaterThan(narrowWidth);

    // The width is a page property, so it survives a reload.
    await page.reload();
    await expect(page.locator('.exocortex-page')).toHaveAttribute('data-layout', 'full', {
      timeout: 15_000,
    });
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

  /**
   * The context panel's "Eigenschaften" tab (issue #17) tells a database, a row
   * and an ordinary page apart: a database shows its row count/columns/views, a
   * row shows the same editable column values the table does, and editing one
   * from the panel has to reach the table too — same data, one editor.
   */
  test('shows different context panel content for a database and one of its rows', async ({
    page,
  }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    const title = `Kontextbereich ${Date.now().toString(36)}`;
    await createDatabase(page, title);
    await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });
    await addProperty(page, 'Priorität', 'Zahl');

    await page.getByTestId('add-row').click();
    await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(1, {
      timeout: 15_000,
    });

    // The database itself: row count, its own properties, its own views.
    await page.getByTestId('context-tab-properties').click();
    await expect(page.getByTestId('collection-properties')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('collection-row-count')).toHaveText('1');
    await expect(page.getByTestId('collection-properties')).toContainText('Priorität');
    await expect(page.getByTestId('row-properties')).toHaveCount(0);

    // Open the row as its own page: now the panel shows the row's own values,
    // through the same PropertyCell the table edits.
    const row = page.locator('[data-testid^="database-row-"]').first();
    await row.getByRole('link').click();
    await expect(page.getByTestId('document-title')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('context-tab-properties').click();
    await expect(page.getByTestId('row-properties')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('collection-properties')).toHaveCount(0);

    const numberInput = page.getByTestId('row-properties').locator('input[type="number"]');
    await numberInput.fill('7');
    await numberInput.blur();

    // Back to the database: the table shows the value just set from the panel.
    await page.getByRole('navigation', { name: 'Pfad' }).getByRole('link', { name: title }).click();
    await expect(page.getByTestId('database-shell')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator('[data-testid^="database-row-"]').first().locator('input[type="number"]'),
    ).toHaveValue('7', { timeout: 15_000 });
  });

  test('shows one appointment in every calendar mode and remembers the mode', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    const title = `Termine ${Date.now().toString(36)}`;
    await createDatabase(page, title);
    await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });
    await addProperty(page, 'Zeitraum', 'Datum');

    // Today, so every mode's window contains it without any navigation.
    //
    // Picked with the picker's own "Heute", which reads the browser's clock:
    // the calendar anchors on that clock too, in Europe/Berlin by the
    // configuration above, while this process runs in the server's UTC. For
    // two hours after midnight in Berlin the two name different days, and a
    // date computed here once put the row off the day grid every night.
    await page.getByTestId('add-row').click();
    const row = page.locator('[data-testid^="database-row-"]').first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator('[data-slot="date-picker"]').click();
    await page.getByRole('button', { name: 'Heute', exact: true }).click();
    await expect(row.locator('[data-slot="date-picker"]')).not.toContainText('Datum wählen');

    await page.getByTestId('add-view').click();
    await page.getByTestId('add-view-calendar').click();
    await page.getByTestId('calendar-date-property').click();
    await page.getByRole('option', { name: 'Zeitraum' }).click();

    const calendar = page.getByTestId('calendar-view');
    const entry = calendar.getByRole('link', { name: 'Unbenannt' });

    // Month is the default, and the row is on it.
    await expect(page.getByTestId('calendar-month')).toBeVisible({ timeout: 15_000 });
    await expect(entry.first()).toBeVisible({ timeout: 15_000 });

    // The same row on a time axis, in both grid modes.
    for (const mode of ['Woche', 'Tag']) {
      await calendar.getByRole('button', { name: mode, exact: true }).click();
      await expect(page.getByTestId('calendar-time-grid')).toBeVisible({ timeout: 15_000 });
      await expect(entry.first()).toBeVisible({ timeout: 15_000 });
    }

    // The year knows the day is busy without naming what is on it.
    await calendar.getByRole('button', { name: 'Jahr', exact: true }).click();
    await expect(page.getByTestId('calendar-year')).toBeVisible({ timeout: 15_000 });

    await calendar.getByRole('button', { name: 'Liste', exact: true }).click();
    await expect(page.getByTestId('calendar-agenda')).toBeVisible({ timeout: 15_000 });
    await expect(entry.first()).toBeVisible({ timeout: 15_000 });

    // The mode is a field on the view, so it survives a reload: the tab opens
    // on the list again, not on the default month.
    await page.reload();
    await page.getByRole('tab', { name: 'Kalender' }).click();
    await expect(page.getByTestId('calendar-agenda')).toBeVisible({ timeout: 15_000 });
  });
  test('filters by a date picked in a calendar inside the filter popover', async ({ page }) => {
    // The date picker opens a popover inside the filter's popover. A click on
    // a day must not read as a click outside the outer one and close it.
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    const title = `Fristen ${Date.now().toString(36)}`;
    await createDatabase(page, title);
    await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });
    await addProperty(page, 'Fällig', 'Datum');

    await page.getByTestId('add-row').click();
    await page.getByTestId('add-row').click();
    const rows = page.locator('[data-testid^="database-row-"]');
    await expect(rows).toHaveCount(2, { timeout: 15_000 });
    await rows.first().locator('[data-slot="date-picker"]').click();
    await page.getByRole('button', { name: 'Heute', exact: true }).click();
    await expect(rows.first().locator('[data-slot="date-picker"]')).not.toContainText(
      'Datum wählen',
    );

    await page.getByTestId('add-filter').click();
    await page.getByTestId('filter-property').click();
    await page.getByRole('option', { name: 'Fällig' }).click();
    await page.getByTestId('filter-value').click();
    await page.getByRole('button', { name: 'Heute', exact: true }).click();
    await expect(page.getByTestId('filter-value')).not.toContainText('Datum wählen');
    await page.getByRole('button', { name: 'Filter hinzufügen' }).click();

    await expect(rows).toHaveCount(1, { timeout: 15_000 });
  });
});

async function addProperty(page: Page, name: string, typeLabel: string): Promise<void> {
  await page.getByTestId('add-property').click();
  await page.getByPlaceholder('Name der Eigenschaft').fill(name);
  // By test id, not by role: the AI panel contributes three comboboxes of its
  // own, so `getByRole('combobox')` is ambiguous on this screen.
  await page.getByTestId('property-type-select').click();
  await page.getByRole('option', { name: typeLabel, exact: true }).click();
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click();
  await expect(page.locator('th', { hasText: name })).toBeVisible({ timeout: 15_000 });
}
