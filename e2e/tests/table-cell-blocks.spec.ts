import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  createDatabase,
  createPage,
  requireSeedCredentials,
  waitForCollaboration,
} from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

/** The browser globals a paste needs, typed for a workspace without the DOM library. */
interface PasteBrowser {
  DataTransfer: new () => { setData: (type: string, value: string) => void };
  ClipboardEvent: new (type: string, init: Record<string, unknown>) => unknown;
}

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Issue #312: a database does not go into a table cell.
 *
 * The rule itself, the drop candidates and the paste transformation are
 * unit-tested in `packages/editor/src/table-cell-blocks.test.ts`. What only a
 * browser proves is that the slash menu really asks where it was opened, that
 * a real drag past the handle lands no database in a cell, and that a real
 * paste event reaches the transformation.
 */
test.describe('no database in a table cell', () => {
  /** A page with a paragraph, a table and the database embedded below it. */
  async function pageWithTableAndDatabase(
    page: Page,
  ): Promise<{ databaseId: string; databaseTitle: string }> {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const stamp = Date.now().toString(36);
    const databaseTitle = `Zellenprobe ${stamp}`;
    const databaseId = await createDatabase(page, databaseTitle);
    const documentId = await createPage(page, `Tabelle mit Datenbank ${stamp}`);
    const markdown = [
      'Oben',
      '| Kopf | Zweite |\n| --- | --- |\n| Zelle | Nachbar |',
      `:::database-embed ${databaseTitle}\n:::`,
      'Unten',
    ].join('\n\n');
    const write = await page.request.post(`/api/documents/${documentId}/content`, {
      data: { markdown: `${markdown}\n`, mode: 'replace' },
    });
    expect(write.ok(), await write.text()).toBe(true);
    await page.reload();
    await waitForCollaboration(page);
    await expect(page.locator('.exocortex-editor td p', { hasText: /^Zelle$/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('.exocortex-editor .exocortex-database-embed')).toHaveCount(1, {
      timeout: 30_000,
    });
    return { databaseId, databaseTitle };
  }

  const cellParagraph = (page: Page): Locator =>
    page.locator('.exocortex-editor td p', { hasText: /^Zelle$/ });
  const databasesInCells = (page: Page): Locator =>
    page.locator('.exocortex-editor td .exocortex-database-embed');

  test('the slash menu offers no database inside a cell, and does outside', async ({ page }) => {
    await pageWithTableAndDatabase(page);

    await cellParagraph(page).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' /');
    // The whole menu is open, so the database is missing because of the cell.
    await expect(page.getByTestId('slash-option-page-link')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('slash-option-database-embed')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.locator('.exocortex-editor p', { hasText: /^Unten$/ }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' /');
    await expect(page.getByTestId('slash-option-database-embed')).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Escape');
  });

  test('a database dragged onto a cell does not land in it', async ({ page }) => {
    await pageWithTableAndDatabase(page);
    const embed = page.locator('.exocortex-editor .exocortex-database-embed');

    const box = await embed.boundingBox();
    if (box === null) throw new Error('embed has no layout');
    await page.mouse.move(box.x + 30, box.y + 4, { steps: 6 });
    const handle = page.getByTestId('block-handle');
    await expect(handle).toBeVisible();
    await expect
      .poll(async () => {
        const at = await handle.boundingBox();
        return at === null ? Number.POSITIVE_INFINITY : Math.abs(at.y - box.y);
      })
      .toBeLessThan(12);
    const at = await handle.boundingBox();
    if (at === null) throw new Error('handle has no layout');

    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    const cell = await cellParagraph(page).boundingBox();
    if (cell === null) throw new Error('cell has no layout');
    await page.mouse.move(cell.x + cell.width / 2, cell.y + cell.height / 2, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator('.exocortex-editor .exocortex-database-embed')).toHaveCount(1);
    await expect(databasesInCells(page)).toHaveCount(0);
    await expect(cellParagraph(page)).toBeVisible();
  });

  test('a database pasted into a cell arrives as a link to it', async ({ page }) => {
    const { databaseId, databaseTitle } = await pageWithTableAndDatabase(page);

    await cellParagraph(page).click();
    await page.keyboard.press('End');
    // What copying the embed puts on the clipboard: its own HTML.
    await page.locator('.exocortex-editor .ProseMirror').evaluate(
      (editor, { id, title }) => {
        // The e2e workspace compiles without the DOM library; the browser has it.
        const browser = globalThis as unknown as PasteBrowser;
        const data = new browser.DataTransfer();
        data.setData(
          'text/html',
          `<div data-database-embed="" data-document-id="${id}" data-title="${title}">${title}</div>`,
        );
        data.setData('text/plain', title);
        editor.dispatchEvent(
          new browser.ClipboardEvent('paste', {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }) as Event,
        );
      },
      { id: databaseId, title: databaseTitle },
    );

    const link = page.locator('.exocortex-editor td [data-page-link]');
    await expect(link).toHaveCount(1, { timeout: 15_000 });
    await expect(link).toContainText(databaseTitle);
    await expect(databasesInCells(page)).toHaveCount(0);
    // The database below the table is still the only one on the page.
    await expect(page.locator('.exocortex-editor .exocortex-database-embed')).toHaveCount(1);
  });
});
