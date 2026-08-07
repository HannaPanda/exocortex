import { expect, type Page, test } from '@playwright/test';

import { createPage, requireSeedCredentials, waitForCollaboration } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Verweise im Editor: anklickbar, `wiki:` löst zu einer echten Seite auf.
 *
 * Vorher: ein Klick auf einen Verweis tat nichts (`openOnClick: false` ohne
 * Ersatz), und `wiki:`-Verweise hatten überhaupt keinen Weg, aufgelöst zu
 * werden. Diese Suite prüft genau die Lücke, die Issue #22 beschreibt.
 */
test.describe('links', () => {
  /** Opens a fresh page and puts the caret in the editor. */
  async function openEditor(page: Page): Promise<void> {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Verweise ${Date.now().toString(36)}`);
    await expect(page.getByTestId('editor-surface')).toBeVisible();
    await page.getByTestId('editor-surface').click();
  }

  /**
   * Creates a root page without asserting the tree contains a unique title —
   * `expectTreeContains` uses `getByText(title, { exact: true })`, which
   * would hit Playwright's strict-mode check the moment a second page shares
   * the title, exactly the case the "ambiguous" test needs.
   */
  async function createPageWithTitle(page: Page, title: string): Promise<string> {
    await page.getByTestId('create-root-page').click();
    await page.getByTestId('create-root-page-item').click();
    await page.waitForURL(/\/seite\/[a-z0-9]+/, { timeout: 30_000 });
    const documentId = new URL(page.url()).pathname.split('/').pop() as string;
    const titleInput = page.getByTestId('document-title');
    await expect(titleInput).toHaveValue('Unbenannte Seite', { timeout: 15_000 });
    await titleInput.fill(title);
    await titleInput.blur();
    await waitForCollaboration(page);
    return documentId;
  }

  test('an external link opens in a new tab', async ({ page, context }) => {
    await openEditor(page);
    await waitForCollaboration(page);

    // The trailing space fires the autolink input rule.
    await page.keyboard.type('https://example.com/ ');
    const anchor = page.locator('.exocortex-editor a[data-link-kind="external"]');
    await expect(anchor).toHaveCount(1);
    await expect(anchor).toHaveAttribute('target', '_blank');
    await expect(anchor).toHaveAttribute('rel', /noopener/);

    const [popup] = await Promise.all([context.waitForEvent('page'), anchor.click()]);
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toContain('example.com');
    await popup.close();
  });

  test('a wiki: link navigates to the exact page it names', async ({ page }) => {
    const marker = Date.now().toString(36);
    const targetTitle = `Ziel ${marker}`;
    const targetId = await createPageWithTitle(page, targetTitle);

    await openEditor(page);
    await waitForCollaboration(page);
    await page.keyboard.type('Siehe Verweis');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');

    await page.getByTestId('mark-link').click();
    await page.getByTestId('link-input').fill(`[[${targetTitle}]]`);
    await page.getByTestId('link-apply').click();

    await page.locator(`.exocortex-editor a[data-link-kind="internal"]`).click();
    await page.waitForURL(new RegExp(`/seite/${targetId}$`), { timeout: 30_000 });
  });

  test('a dead wiki: link offers to create the page it names', async ({ page }) => {
    const marker = Date.now().toString(36);
    const missingTitle = `Gibt es nicht ${marker}`;

    await openEditor(page);
    await waitForCollaboration(page);
    await page.keyboard.type('Toter Verweis');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');

    await page.getByTestId('mark-link').click();
    await page.getByTestId('link-input').fill(`[[${missingTitle}]]`);
    await page.getByTestId('link-apply').click();

    await page.locator('.exocortex-editor a[data-link-kind="internal"]').click();
    await expect(page.getByTestId('link-missing-dialog')).toBeVisible();
    await page.getByTestId('link-create-page').click();

    await page.waitForURL(/\/seite\/[a-z0-9]+$/, { timeout: 30_000 });
    await expect(page.getByTestId('document-title')).toHaveValue(missingTitle);
  });

  test('an ambiguous wiki: link offers a choice between same-titled pages', async ({ page }) => {
    const marker = Date.now().toString(36);
    const sharedTitle = `Doppelt ${marker}`;

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const firstId = await createPageWithTitle(page, sharedTitle);
    const secondId = await createPageWithTitle(page, sharedTitle);

    await openEditor(page);
    await waitForCollaboration(page);
    await page.keyboard.type('Mehrdeutiger Verweis');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');

    await page.getByTestId('mark-link').click();
    await page.getByTestId('link-input').fill(`[[${sharedTitle}]]`);
    await page.getByTestId('link-apply').click();

    await page.locator('.exocortex-editor a[data-link-kind="internal"]').click();
    const dialog = page.getByTestId('link-ambiguous-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId(`link-ambiguous-option-${firstId}`)).toBeVisible();
    await expect(dialog.getByTestId(`link-ambiguous-option-${secondId}`)).toBeVisible();

    await dialog.getByTestId(`link-ambiguous-option-${secondId}`).click();
    await page.waitForURL(new RegExp(`/seite/${secondId}$`), { timeout: 30_000 });
  });

  test('Alt-click places the caret instead of following the link', async ({ page }) => {
    const marker = Date.now().toString(36);
    const targetTitle = `Alt-Klick-Ziel ${marker}`;
    await createPageWithTitle(page, targetTitle);

    await openEditor(page);
    await waitForCollaboration(page);
    const documentUrl = page.url();

    await page.keyboard.type('Verweis vor Text');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');

    await page.getByTestId('mark-link').click();
    await page.getByTestId('link-input').fill(`[[${targetTitle}]]`);
    await page.getByTestId('link-apply').click();

    await page.keyboard.down('Alt');
    await page.locator('.exocortex-editor a[data-link-kind="internal"]').click();
    await page.keyboard.up('Alt');

    // The URL is unchanged: Alt held the link still, and the caret landed
    // where it was clicked rather than the click following the link.
    expect(page.url()).toBe(documentUrl);
    await page.keyboard.type('X');
    await expect(page.getByTestId('editor-surface')).toContainText('X');
  });

  test('the page-link block shows its resolution and can be followed', async ({ page }) => {
    const marker = Date.now().toString(36);
    const targetTitle = `Blockziel ${marker}`;
    const targetId = await createPageWithTitle(page, targetTitle);

    await openEditor(page);
    await waitForCollaboration(page);
    await page.keyboard.type('/seitenlink');
    await expect(page.getByTestId('slash-option-page-link')).toBeVisible();
    await page.getByTestId('slash-option-page-link').click();

    await page.getByTestId('block-prompt-input').fill(targetTitle);
    await page.getByTestId('block-prompt-submit').click();

    const card = page.getByTestId('page-link-card');
    await expect(card).toBeVisible();
    await card.click();
    await page.waitForURL(new RegExp(`/seite/${targetId}$`), { timeout: 30_000 });
  });

  test('the page-link block shows a dead link for an unknown title', async ({ page }) => {
    const marker = Date.now().toString(36);
    const missingTitle = `Kein Block-Ziel ${marker}`;

    await openEditor(page);
    await waitForCollaboration(page);
    await page.keyboard.type('/seitenlink');
    await expect(page.getByTestId('slash-option-page-link')).toBeVisible();
    await page.getByTestId('slash-option-page-link').click();

    await page.getByTestId('block-prompt-input').fill(missingTitle);
    await page.getByTestId('block-prompt-submit').click();

    await expect(page.getByTestId('page-link-missing')).toBeVisible();
    await expect(page.getByTestId('page-link-missing')).toContainText(missingTitle);
  });

  test('a link is still clickable on a read-only, archived page', async ({ page }) => {
    const marker = Date.now().toString(36);
    const targetTitle = `Nur lesbar Ziel ${marker}`;
    const targetId = await createPageWithTitle(page, targetTitle);

    await openEditor(page);
    await waitForCollaboration(page);
    const documentId = new URL(page.url()).pathname.split('/').pop() as string;
    const workspaceId = /\/arbeitsbereich\/([a-z0-9]+)\//.exec(page.url())?.[1] as string;

    await page.keyboard.type('Verweis auf archivierter Seite');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.getByTestId('mark-link').click();
    await page.getByTestId('link-input').fill(`[[${targetTitle}]]`);
    await page.getByTestId('link-apply').click();

    await page.getByTestId('document-actions').click();
    await page.getByTestId('archive-document').click();
    await page.waitForURL(new RegExp(`/arbeitsbereich/${workspaceId}$`));

    await page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
    await expect(page.getByTestId('archived-banner')).toBeVisible();

    await page.locator('.exocortex-editor a[data-link-kind="internal"]').click();
    await page.waitForURL(new RegExp(`/seite/${targetId}$`), { timeout: 30_000 });
  });
});
