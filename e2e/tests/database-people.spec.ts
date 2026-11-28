import { expect, type Page, test } from '@playwright/test';

import { addRowAndClosePeek, createDatabase, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

async function addProperty(page: Page, name: string, typeLabel: string): Promise<void> {
  await page.getByTestId('add-property').click();
  await page.getByPlaceholder('Name der Eigenschaft').fill(name);
  await page.getByTestId('property-type-select').click();
  await page.getByRole('option', { name: typeLabel, exact: true }).click();
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click();
  await expect(page.locator('th', { hasText: name })).toBeVisible({ timeout: 15_000 });
}

test.describe('people in a database cell (issue #314)', () => {
  test('picks a member by name with the keyboard, takes them out again and shows the name everywhere', async ({
    page,
  }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    await createDatabase(page, `Zuständige ${Date.now().toString(36)}`);
    await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });
    await addProperty(page, 'Zuständig', 'Person');
    await addProperty(page, 'Angelegt von', 'Erstellt von');
    await addRowAndClosePeek(page);

    const tableRow = page.locator('[data-testid^="database-row-"]').first();
    await expect(tableRow).toBeVisible({ timeout: 15_000 });
    const cell = tableRow.locator('[data-testid^="person-cell-"]').first();
    await expect(cell).toHaveText('Leer');

    // Who created the row reads as a name, never as an account id.
    const creator = tableRow.locator('[data-testid^="person-cell-"]').nth(1);
    await expect(creator.locator('[data-person-state="member"]')).toHaveCount(1, {
      timeout: 15_000,
    });
    const myName = (await creator.innerText()).replace(/^\S+\s*/, '').trim();
    expect(myName.length).toBeGreaterThan(0);

    // The picker offers the members by name and searches them.
    await cell.click();
    const picker = page.getByTestId('person-picker');
    await expect(picker).toBeVisible();
    const search = picker.getByTestId('person-search');
    await expect(search).toBeFocused();
    await expect(picker.getByTestId('person-option').first()).toBeVisible({ timeout: 15_000 });
    await search.fill(myName.slice(0, 3));
    await expect(picker.getByTestId('person-option').filter({ hasText: myName })).toBeVisible();

    // Arrow and Enter pick; Backspace in the empty search takes the last one out.
    await search.press('ArrowDown');
    await search.press('Enter');
    const chip = picker.locator('[data-slot="combobox-chip"]');
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText(myName);
    await search.fill('');
    await search.press('Backspace');
    await expect(chip).toHaveCount(0);

    // Picked again, Escape commits and the cell shows the name.
    await picker.getByTestId('person-option').filter({ hasText: myName }).click();
    await expect(chip).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(cell).toContainText(myName, { timeout: 15_000 });

    // It survives a reload, and the row's page header shows the same name.
    await page.reload();
    const reloadedRow = page.locator('[data-testid^="database-row-"]').first();
    await expect(reloadedRow.locator('[data-testid^="person-cell-"]').first()).toContainText(
      myName,
      { timeout: 30_000 },
    );
    await reloadedRow.getByTestId('open-row-peek').click();
    const peek = page.getByTestId('row-peek');
    await expect(peek.getByTestId('row-properties-header')).toContainText(myName, {
      timeout: 15_000,
    });
  });
});
