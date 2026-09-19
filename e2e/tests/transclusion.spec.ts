import { expect, type Page, test } from '@playwright/test';

import {
  createPage,
  requireSeedCredentials,
  waitForCollaboration,
  waitForMaterialization,
} from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Transclusion: content shown here, owned somewhere else (issue #78, ADR-045).
 *
 * What only a browser can prove is the loop: the block is inserted through the
 * slash menu, resolves against the real API, and shows text that is not in this
 * page's own document. The rules underneath (which blocks a heading brings
 * along, what a dead reference answers, what an export carries) are asserted in
 * `packages/editor` and in the API's integration suite, where they cost
 * milliseconds rather than a browser.
 */
test.describe('transclusion', () => {
  /** A source page carrying one paragraph, persisted before anybody embeds it. */
  async function createSource(page: Page, title: string, text: string): Promise<string> {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const documentId = await createPage(page, title);
    await expect(page.getByTestId('editor-surface')).toBeVisible();
    await page.getByTestId('editor-surface').click();
    await waitForCollaboration(page);
    await page.keyboard.type(text);
    // The fragment is read from the stored state, so the keystrokes have to
    // have reached it before another page embeds this one.
    await waitForMaterialization(page, documentId, text);
    return documentId;
  }

  /** Inserts a transclusion block and picks `targetId` as its source. */
  async function embed(page: Page, search: string, targetId: string): Promise<void> {
    await page.keyboard.type('/einbetten');
    await expect(page.getByTestId('slash-option-transclusion')).toBeVisible();
    await page.getByTestId('slash-option-transclusion').click();
    await page.getByTestId('block-prompt-input').fill(search);
    await page.getByTestId(`page-prompt-option-${targetId}`).click();
  }

  test('shows the source page inside another page', async ({ page }) => {
    const marker = Date.now().toString(36);
    const sourceTitle = `Stammdaten ${marker}`;
    const sourceText = `Der eine Satz ${marker}`;
    const sourceId = await createSource(page, sourceTitle, sourceText);

    await page.goto('/arbeitsbereich');
    await createPage(page, `Zeigt Stammdaten ${marker}`);
    await page.getByTestId('editor-surface').click();
    await waitForCollaboration(page);
    await embed(page, sourceTitle, sourceId);

    const block = page.locator('.exocortex-transclusion');
    await expect(block).toBeVisible();
    await expect(block.getByTestId('transclusion-content')).toContainText(sourceText, {
      timeout: 30_000,
    });
    // The text is shown, not owned: the reference is what this page stores, so
    // the source is one click away rather than copied in.
    await expect(block.getByTestId('transclusion-open-source')).toBeVisible();
  });

  test('keeps showing the source after it has been renamed', async ({ page }) => {
    const marker = Date.now().toString(36);
    const sourceTitle = `Umbenennbar ${marker}`;
    const renamed = `Heißt jetzt anders ${marker}`;
    const sourceText = `Bleibt sichtbar ${marker}`;
    const sourceId = await createSource(page, sourceTitle, sourceText);

    await page.goto('/arbeitsbereich');
    await createPage(page, `Zeigt Umbenennbares ${marker}`);
    await page.getByTestId('editor-surface').click();
    await waitForCollaboration(page);
    await embed(page, sourceTitle, sourceId);
    await expect(page.getByTestId('transclusion-content')).toContainText(sourceText, {
      timeout: 30_000,
    });

    const embeddingUrl = page.url();
    await page.goto(embeddingUrl.replace(/\/seite\/[a-z0-9]+$/, `/seite/${sourceId}`));
    const titleInput = page.getByTestId('document-title');
    await expect(titleInput).toHaveValue(sourceTitle, { timeout: 15_000 });
    await titleInput.fill(renamed);
    await titleInput.blur();
    await waitForCollaboration(page);

    await page.goto(embeddingUrl);
    const block = page.locator('.exocortex-transclusion');
    // The reference is an identity: the content is still there, under the name
    // the source carries now rather than the one frozen at insertion.
    await expect(block.getByTestId('transclusion-content')).toContainText(sourceText, {
      timeout: 30_000,
    });
    await expect(block).toContainText(renamed);
  });

  test('offers the source blocks and narrows the embedding to one section', async ({ page }) => {
    const marker = Date.now().toString(36);
    const sourceTitle = `Zwei Abschnitte ${marker}`;
    const sourceId = await createSource(page, sourceTitle, `Erster Abschnitt ${marker}`);

    // A second paragraph, so choosing the first block is visibly narrower than
    // taking the whole page.
    await page.keyboard.press('Enter');
    await page.keyboard.type(`Zweiter Abschnitt ${marker}`);
    await waitForMaterialization(page, sourceId, `Zweiter Abschnitt ${marker}`);

    await page.goto('/arbeitsbereich');
    await createPage(page, `Zeigt einen Abschnitt ${marker}`);
    await page.getByTestId('editor-surface').click();
    await waitForCollaboration(page);
    await embed(page, sourceTitle, sourceId);

    const block = page.locator('.exocortex-transclusion');
    await expect(block.getByTestId('transclusion-content')).toContainText(
      `Zweiter Abschnitt ${marker}`,
      { timeout: 30_000 },
    );

    await block.getByTestId('transclusion-choose-block').click();
    const firstBlock = page.locator('[data-testid^="transclusion-block-"]').first();
    await expect(firstBlock).toBeVisible({ timeout: 30_000 });
    await firstBlock.click();

    await expect(block.getByTestId('transclusion-content')).toContainText(
      `Erster Abschnitt ${marker}`,
      { timeout: 30_000 },
    );
    await expect(block.getByTestId('transclusion-content')).not.toContainText(
      `Zweiter Abschnitt ${marker}`,
    );
  });
});
