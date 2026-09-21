import { expect, type Page, test } from '@playwright/test';

import { requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Issue #115: Strg + K used to open on "Mindestens zwei Zeichen eingeben".
 *
 * That asks the reader to remember a title before the surface will help, in a
 * product whose accessibility requirement is that nothing may demand you
 * remember where you were, and whose second purpose after writing is finding
 * things again. And it called itself a command palette while offering two
 * commands, neither of them the four that existed only as key combinations.
 */
async function openWorkspace(page: Page): Promise<void> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  await expect(page.getByTestId('page-tree')).toBeVisible({ timeout: 30_000 });
}

/** The group headings, in the order the palette lists them. */
async function groups(page: Page): Promise<string[]> {
  return page.getByRole('listbox').locator('> li > p').allInnerTexts();
}

test.describe('Kommandopalette', () => {
  test('ist ohne Eingabe schon nützlich', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('open-search').click();

    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();
    // Die zuletzt bearbeiteten Seiten zuerst: die eine Liste, die kein
    // Erinnern verlangt, und damit das, was die Eingabetaste trifft.
    expect(await groups(page)).toEqual(['Zuletzt bearbeitet', 'Aktionen']);
    await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');

    // Und die Befehle, die es vorher nur als Tastenkürzel gab.
    await expect(list.getByRole('option', { name: /Etwas erfassen/ })).toHaveCount(1);
    await expect(list.getByRole('option', { name: /Papierkorb öffnen/ })).toHaveCount(1);
  });

  test('führt einen getippten Befehl aus, ohne dass die Navigation offen ist', async ({ page }) => {
    await openWorkspace(page);
    // Der Papierkorb hing früher im Seitenbaum und war damit nur erreichbar,
    // solange die Navigation offen war.
    await page.getByTestId('toggle-sidebar').click();
    await expect(page.getByTestId('page-tree')).toHaveCount(0);

    await page.getByTestId('open-search').click();
    await page.keyboard.type('papier');
    await expect(page.getByRole('listbox').getByRole('option').first()).toContainText(
      'Papierkorb öffnen',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('trash-sheet')).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press('Escape');
    await page.getByTestId('toggle-sidebar').click();
    await expect(page.getByTestId('page-tree')).toBeVisible();
  });

  test('öffnet nicht mit der Frage von gestern', async ({ page }) => {
    await openWorkspace(page);
    await page.getByTestId('open-search').click();
    await page.keyboard.type('papier');
    expect(await groups(page)).toEqual(['Aktionen', 'Seiten']);

    await page.keyboard.press('Escape');
    await page.getByTestId('open-search').click();
    await expect(page.getByRole('combobox')).toHaveValue('');
    expect(await groups(page)).toEqual(['Zuletzt bearbeitet', 'Aktionen']);
  });
});
