import { expect, test } from '@playwright/test';

import { requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * The help page (issue #80, ADR-040).
 *
 * Worth a browser test rather than a unit test because the two things that
 * make it usable are layout decisions: one area at a time behind a side
 * navigation, and a search that spans all of them. Both are the kind of thing
 * that keeps type-checking and compiling after it has stopped working.
 */
test.describe('Hilfe und Funktionen', () => {
  test.use({ storageState: storageStatePath('johanna') });

  test.beforeAll(() => {
    requireSeedCredentials();
  });

  test('shows one area at a time and explains each feature in full', async ({ page }) => {
    await page.goto('/hilfe');

    await expect(page.getByRole('heading', { name: 'Hilfe und Funktionen' })).toBeVisible();
    await expect(page.getByTestId('feature-areas')).toBeVisible();

    // The default area, not the whole catalogue: the point of the tabs is that
    // a reader meets one area rather than sixty entries.
    const entries = page.getByTestId('feature-entry');
    const overviewCount = await entries.count();
    expect(overviewCount).toBeGreaterThan(0);

    await page.getByTestId('feature-area-datenbanken').click();
    await expect(page.getByRole('heading', { name: 'Datenbanken', exact: true })).toBeVisible();
    await expect(page.getByText('Datenbanken mit Zeilen, die richtige Seiten sind')).toBeVisible();

    // An entry carries paragraphs, not a one-liner. Three is what the registry
    // is written to, and the catalogue's own test holds the floor at two.
    const paragraphs = entries.first().locator('p');
    expect(await paragraphs.count()).toBeGreaterThanOrEqual(3);
  });

  test('searches across every area and falls back to the whole list', async ({ page }) => {
    await page.goto('/hilfe');
    await expect(page.getByTestId('feature-areas')).toBeVisible();

    // "Überblick" is open, and LaTeX is not in it: the page has to show the
    // matches from the other areas instead of an empty panel.
    await page.getByTestId('feature-search').fill('latexmk');
    await expect(page.getByText('Bauen mit latexmk, samt Fehlerliste')).toBeVisible();

    await page.getByTestId('feature-search').fill('kaesekuchen');
    await expect(page.getByText('Nichts gefunden')).toBeVisible();
  });
});
