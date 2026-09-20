import { expect, type Page, test } from '@playwright/test';

import { createPage, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Der Seitenbaum als echte Baum-Navigation.
 *
 * Vorher hatte jede Zeile vier Tabstopps: Pfeil, Symbol, Link und „Unterseite
 * anlegen". Bis zur zehnten Seite waren das vierzig Tastendrücke, in einem
 * Produkt, dessen erster Designgrundsatz „was mit der Tastatur geht, muss mit
 * der Tastatur gehen" lautet. Jetzt gilt das WAI-ARIA-Muster `tree`: ein
 * Tabstopp, Pfeiltasten dazwischen.
 *
 * Getestet wird die Bedienung, nicht die Attribute. Ein `role="tree"` ohne
 * Pfeiltasten wäre genau der halbe Baum, der schlechter ist als gar keiner.
 */
async function openWorkspace(page: Page): Promise<void> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  await expect(page.getByTestId('page-tree')).toBeVisible({ timeout: 30_000 });
}

/** Die Kennung der Zeile, die gerade den Fokus hat. */
async function focusedRow(page: Page): Promise<string | null> {
  return page
    .locator('[role="treeitem"]:focus')
    .first()
    .getAttribute('data-tree-item')
    .catch(() => null);
}

test.describe('Seitenbaum mit der Tastatur', () => {
  test('hat genau einen Tabstopp, und keine Zeile hat einen zweiten', async ({ page }) => {
    await openWorkspace(page);

    const tree = page.getByTestId('page-tree');
    await expect(tree).toHaveAttribute('role', 'tree');
    await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);

    // Und alles in einer Zeile ist bedienbar, aber nicht anspringbar.
    const insideRows = await tree
      .locator('[data-tree-row] a, [data-tree-row] button')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('tabindex')).filter((v) => v !== '-1'),
      );
    expect(insideRows, 'Eine Zeile hat wieder einen eigenen Tabstopp').toEqual([]);
  });

  test('bewegt den Fokus mit den Pfeiltasten und faltet damit auf und zu', async ({ page }) => {
    await openWorkspace(page);
    const marker = Date.now().toString(36);
    const parentId = await createPage(page, `Tastatur-Eltern ${marker}`);

    // Ein Kind anlegen, damit es etwas aufzufalten gibt.
    const parentUrl = page.url();
    await page.getByTestId(`tree-item-${parentId}`).hover();
    await page
      .getByTestId(`tree-item-${parentId}`)
      .getByRole('button', { name: /Unterseite/ })
      .click();
    await page.waitForURL(
      (url) => url.toString() !== parentUrl && /\/seite\/[a-z0-9]+/.test(url.pathname),
    );
    const childId = /\/seite\/([a-z0-9]+)/.exec(page.url())?.[1] ?? '';
    expect(childId).not.toBe('');

    const parentRow = page.locator(`[data-tree-item="${parentId}"]`);
    await parentRow.focus();
    expect(await focusedRow(page)).toBe(parentId);

    // Zufalten, dann mit Pfeil rechts wieder auf, dann hinein.
    await page.keyboard.press('ArrowLeft');
    await expect(parentRow).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowRight');
    await expect(parentRow).toHaveAttribute('aria-expanded', 'true');
    expect(await focusedRow(page), 'Aufklappen darf noch nicht hineinspringen').toBe(parentId);
    await page.keyboard.press('ArrowRight');
    expect(await focusedRow(page)).toBe(childId);

    // Und wieder heraus, zurück zur Elternzeile.
    await page.keyboard.press('ArrowLeft');
    expect(await focusedRow(page)).toBe(parentId);

    // Auf und ab bewegen sich Zeile für Zeile, Pos1 und Ende an die Enden.
    await page.keyboard.press('ArrowDown');
    expect(await focusedRow(page)).toBe(childId);
    await page.keyboard.press('ArrowUp');
    expect(await focusedRow(page)).toBe(parentId);

    const firstId = await page.locator('[role="treeitem"]').first().getAttribute('data-tree-item');
    await page.keyboard.press('Home');
    expect(await focusedRow(page)).toBe(firstId);
  });

  test('öffnet die Seite mit der Eingabetaste', async ({ page }) => {
    await openWorkspace(page);
    const marker = Date.now().toString(36);
    const targetId = await createPage(page, `Tastatur-Ziel ${marker}`);

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await page.locator(`[data-tree-item="${targetId}"]`).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`/seite/${targetId}`), { timeout: 30_000 });
  });

  /**
   * Der Preis des Musters: die drei Knöpfe in der Zeile sind kein Tabstopp
   * mehr. Bezahlt wird er mit dem Zeilenmenü, und das muss deshalb auch von der
   * Tastatur aus aufgehen, sonst wäre „Unterseite anlegen" für die Tastatur
   * verloren.
   */
  test('öffnet das Zeilenmenü mit Umschalt + F10', async ({ page }) => {
    await openWorkspace(page);
    const marker = Date.now().toString(36);
    const targetId = await createPage(page, `Tastatur-Menü ${marker}`);

    await page.locator(`[data-tree-item="${targetId}"]`).focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByTestId(`tree-move-up-${targetId}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('menuitem', { name: 'Unterseite anlegen' })).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
