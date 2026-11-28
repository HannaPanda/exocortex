import { expect, type Page, test } from '@playwright/test';

import { createPage, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

/**
 * The `:` emoji list (issue #269), in the editor and in the chat field.
 *
 * Where a colon may open it is unit-tested (`lib/emoji-shortcode.test.ts`,
 * `emoji-shortcode-menu.test.ts`); what only a browser proves is the real
 * keys, the lazily loaded data arriving, and that the chat's Escape closes the
 * list and nothing around it. Nothing here sends a message: the chat field is
 * only typed into, so no run starts. Every page is deleted afterwards.
 */
test.beforeAll(() => {
  requireSeedCredentials();
});

const created: string[] = [];

test.afterEach(async ({ request, baseURL }) => {
  for (const id of created.splice(0)) {
    await request.delete(`/api/documents/${id}`, { headers: { origin: baseURL as string } });
  }
});

async function openNewPage(page: Page, title: string): Promise<void> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  created.push(await createPage(page, `${title} ${Date.now().toString(36)}`));
}

async function openEditor(page: Page): Promise<void> {
  await openNewPage(page, 'Emoji');
  await expect(page.getByTestId('editor-surface')).toBeVisible();
  await page.getByTestId('editor-surface').click();
}

/** The first paragraph's text. */
function firstParagraph(page: Page) {
  return page.locator('.exocortex-editor p').first();
}

test.describe('in the editor', () => {
  test('filters by a German word and inserts with Enter', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type('Gut gemacht :herz');
    const list = page.getByTestId('emoji-suggestions');
    await expect(list).toBeVisible();
    await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('emoji-suggestion-❤️')).toBeVisible();

    await page.keyboard.press('Enter');
    await expect(list).toBeHidden();
    await expect(firstParagraph(page)).toHaveText('Gut gemacht ❤️');
  });

  test('moves with the arrow keys and takes a click', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type(':daumen');
    const options = page.getByTestId('emoji-suggestions').getByRole('option');
    await expect(options.nth(1)).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    const second = (await options.nth(1).locator('span').first().textContent()) ?? '';
    await page.keyboard.press('Enter');
    await expect(firstParagraph(page)).toHaveText(second);

    await page.keyboard.type(' :tada');
    await page.getByTestId('emoji-suggestion-🎉').click();
    await expect(firstParagraph(page)).toHaveText(`${second} 🎉`);
  });

  test('a shortcode typed out to its closing colon becomes its emoji', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type('Fertig :tada:');
    await expect(firstParagraph(page)).toHaveText('Fertig 🎉');
  });

  test('Escape closes the list and keeps the text', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type('a :herz');
    await expect(page.getByTestId('emoji-suggestions')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('emoji-suggestions')).toBeHidden();
    await expect(firstParagraph(page)).toHaveText('a :herz');
  });

  test('a time, an address and an emoticon open nothing', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type('Um 12:30 auf https://exocortex.app schauen :)');
    await expect(firstParagraph(page)).toHaveText('Um 12:30 auf https://exocortex.app schauen :)');
    await expect(page.getByTestId('emoji-suggestions')).toHaveCount(0);
    // A single letter, then Enter, is an emoticon and a new line.
    await page.keyboard.type(' :D');
    await expect(page.getByTestId('emoji-suggestions')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.exocortex-editor p')).toHaveCount(2);
    await expect(firstParagraph(page)).toHaveText(
      'Um 12:30 auf https://exocortex.app schauen :) :D',
    );
  });

  test('inline code opens nothing', async ({ page }) => {
    await openEditor(page);
    // The closing backtick makes "code" inline code; then back into it.
    await page.keyboard.type('Siehe `code` ');
    await expect(page.locator('.exocortex-editor p code')).toHaveText('code');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type(' :tada');
    await expect(page.locator('.exocortex-editor p code')).toContainText(':tada');
    await expect(page.getByTestId('emoji-suggestions')).toHaveCount(0);
  });
});

test.describe('in the chat field', () => {
  async function openChat(page: Page): Promise<void> {
    await openNewPage(page, 'Emoji-Chat');
    await page.getByTestId('context-tab-ai').click();
    await expect(page.getByTestId('ai-input')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('ai-input').click();
  }

  test('offers the same list and inserts at the caret', async ({ page }) => {
    await openChat(page);
    const field = page.getByTestId('ai-input');
    await page.keyboard.type('Danke :herz');
    const list = page.getByTestId('emoji-suggestions');
    await expect(list).toBeVisible();
    await expect(page.getByTestId('emoji-suggestion-❤️')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(field).toHaveValue('Danke ❤️');
    await expect(field).toBeFocused();

    await page.keyboard.type(' und :tada:');
    await expect(field).toHaveValue('Danke ❤️ und 🎉');
  });

  test('a time and code open nothing, and Escape keeps the text', async ({ page }) => {
    await openChat(page);
    const field = page.getByTestId('ai-input');
    await page.keyboard.type('Um 12:30 ');
    await page.keyboard.type('`x :herz');
    await expect(page.getByTestId('emoji-suggestions')).toHaveCount(0);

    await field.fill('');
    await page.keyboard.type('Gut :herz');
    await expect(page.getByTestId('emoji-suggestions')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('emoji-suggestions')).toBeHidden();
    await expect(field).toHaveValue('Gut :herz');
  });
});

test.describe('in the chat field on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('Escape closes the list and not the chat around it', async ({ page }) => {
    await openNewPage(page, 'Emoji-Telefon');
    await page.getByTestId('toggle-context').tap();
    await page.getByTestId('context-tab-ai').tap();
    const field = page.getByTestId('ai-input');
    await expect(field).toBeVisible({ timeout: 30_000 });
    await field.tap();
    await page.keyboard.type('Gut :herz');
    await expect(page.getByTestId('emoji-suggestions')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('emoji-suggestions')).toBeHidden();
    await expect(page.getByTestId('context-panel')).toBeVisible();
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('Gut :herz');
  });
});
