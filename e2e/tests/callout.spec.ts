import { expect, type Page, test } from '@playwright/test';

import { createPage, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * The callout of issue #306: one entry "Hinweis", a symbol that opens the
 * menu, a heading and a frame colour, and all of it by keyboard too. What the
 * box stores and how the old variants are carried over is covered in
 * `packages/editor/src/callout.test.ts`; this is what only a browser shows.
 */
test.describe('callout', () => {
  async function openEditor(page: Page): Promise<void> {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Hinweis ${Date.now().toString(36)}`);
    await expect(page.getByTestId('editor-surface')).toBeVisible();
    await page.getByTestId('editor-surface').click();
  }

  async function insertCallout(page: Page, text: string): Promise<void> {
    await page.keyboard.type('/hinweis');
    await expect(page.getByTestId('slash-option-callout')).toBeVisible();
    await page.keyboard.press('Enter');
    await page.keyboard.type(text);
  }

  const box = (page: Page) => page.locator('.exocortex-editor aside.exocortex-callout');
  const symbol = (page: Page) => box(page).locator('button[data-callout-emoji]');

  test('offers one entry and starts with the light bulb', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type('/hinweis');
    await expect(page.getByTestId('slash-option-callout')).toBeVisible();
    // The five variants are one block now.
    await expect(page.locator('[data-testid^="slash-option-callout-"]')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Im Kasten');

    await expect(box(page)).toHaveCount(1);
    await expect(box(page)).toHaveAttribute('role', 'note');
    await expect(symbol(page)).toHaveText('💡');
    await expect(symbol(page)).toHaveAccessibleName(/💡/);
    await expect(box(page).locator('.exocortex-callout-content')).toHaveText('Im Kasten');
  });

  test('changes heading, colour and symbol from the menu behind the symbol', async ({ page }) => {
    await openEditor(page);
    await insertCallout(page, 'Bitte lesen');

    await symbol(page).click();
    const menu = page.getByTestId('callout-menu');
    await expect(menu).toBeVisible();

    // A suggested heading, then one typed with a space in it.
    await page.getByTestId('callout-title-caution').click();
    await expect(box(page).locator('[data-callout-title]')).toHaveText('Achtung');
    await page.getByTestId('callout-title-input').fill('Sehr wichtig');
    await expect(box(page).locator('[data-callout-title]')).toHaveText('Sehr wichtig');

    // The colour's name is written out next to the swatches.
    await page.getByTestId('callout-color-red').click();
    await expect(box(page)).toHaveAttribute('data-color', 'red');
    await expect(menu).toContainText('Rot');

    await page.getByTestId('callout-emoji-search').fill('warnung');
    await page.getByTestId('callout-emoji-⚠️').first().click();
    await expect(menu).toBeHidden();
    await expect(symbol(page)).toHaveText('⚠️');

    // A press on the heading opens the same menu, at the heading.
    await box(page).locator('[data-callout-title]').click();
    await expect(page.getByTestId('callout-title-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // One undo takes the last change back, like any other edit.
    await page.keyboard.press('Control+z');
    await expect(symbol(page)).not.toHaveText('⚠️');
  });

  test('is reachable by keyboard: Tab to the symbol, Enter, Escape back', async ({ page }) => {
    await openEditor(page);
    await insertCallout(page, 'Tastatur');

    await page.keyboard.press('Tab');
    await expect(symbol(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('callout-menu')).toBeVisible();
    await expect(page.getByTestId('callout-emoji-search')).toBeFocused();

    // The colours are one group the arrow keys walk through.
    await page.getByTestId('callout-color-default').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(box(page)).toHaveAttribute('data-color', 'gray');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('callout-menu')).toBeHidden();
    // Back in the text, where typing goes on.
    await page.keyboard.type(' weiter');
    await expect(box(page).locator('.exocortex-callout-content')).toHaveText('Tastatur weiter');

    // From the symbol, Escape goes back to the text as well.
    await page.keyboard.press('Tab');
    await expect(symbol(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.type('!');
    await expect(box(page).locator('.exocortex-callout-content')).toHaveText('Tastatur weiter!');
  });

  test('leaves Tab to a list inside the box', async ({ page }) => {
    await openEditor(page);
    await insertCallout(page, '- Eins');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Zwei');
    await page.keyboard.press('Tab');

    // The second point became a sub-point of the first; the symbol kept still.
    await expect(box(page).locator('li li')).toHaveText('Zwei');
    await expect(symbol(page)).not.toBeFocused();
  });
});
