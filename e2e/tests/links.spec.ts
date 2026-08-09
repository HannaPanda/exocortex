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
    // The `page` fixture starts at `about:blank`, and the button this clicks
    // lives in the page tree — so a test that calls this as its first action
    // has to arrive somewhere first. Tests that already navigated keep their
    // place, which is what the "ambiguous" test needs to make two pages in a
    // row.
    if (!/\/arbeitsbereich\/[a-z0-9]+/.test(page.url())) {
      await page.goto('/arbeitsbereich');
      await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    }
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

  /** Opens the slash menu's page picker and types into its search field. */
  async function openPagePicker(page: Page, search: string): Promise<void> {
    await page.keyboard.type('/seitenlink');
    await expect(page.getByTestId('slash-option-page-link')).toBeVisible();
    await page.getByTestId('slash-option-page-link').click();
    await page.getByTestId('block-prompt-input').fill(search);
  }

  test('the page-link block is filled from a picker and can be followed', async ({ page }) => {
    const marker = Date.now().toString(36);
    const targetTitle = `Blockziel ${marker}`;
    const targetId = await createPageWithTitle(page, targetTitle);

    await openEditor(page);
    await waitForCollaboration(page);
    await openPagePicker(page, targetTitle);
    await page.getByTestId(`page-prompt-option-${targetId}`).click();

    const card = page.getByTestId('page-link-card');
    await expect(card).toBeVisible();
    await card.getByRole('link').click();
    await page.waitForURL(new RegExp(`/seite/${targetId}$`), { timeout: 30_000 });
  });

  test('a page-link block picked from the list survives its target being renamed', async ({
    page,
  }) => {
    const marker = Date.now().toString(36);
    const targetTitle = `Umzubenennen ${marker}`;
    const renamedTitle = `Heißt jetzt anders ${marker}`;
    const targetId = await createPageWithTitle(page, targetTitle);

    await openEditor(page);
    await waitForCollaboration(page);
    await openPagePicker(page, targetTitle);
    await page.getByTestId(`page-prompt-option-${targetId}`).click();
    await expect(page.getByTestId('page-link-card')).toContainText(targetTitle);

    const sourceUrl = page.url();
    await page.goto(sourceUrl.replace(/\/seite\/[a-z0-9]+$/, `/seite/${targetId}`));
    const titleInput = page.getByTestId('document-title');
    await expect(titleInput).toHaveValue(targetTitle, { timeout: 15_000 });
    await titleInput.fill(renamedTitle);
    await titleInput.blur();
    await waitForCollaboration(page);

    await page.goto(sourceUrl);
    // The reference is an identity: it still resolves, and it shows the new name.
    const card = page.getByTestId('page-link-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText(renamedTitle);
  });

  test('the page-link block shows a dead link for an unknown title and can be re-targeted', async ({
    page,
  }) => {
    const marker = Date.now().toString(36);
    const missingTitle = `Kein Block-Ziel ${marker}`;
    const realTitle = `Doch ein Ziel ${marker}`;
    const realId = await createPageWithTitle(page, realTitle);

    await openEditor(page);
    await waitForCollaboration(page);
    await openPagePicker(page, missingTitle);
    // No page carries that title, so the picker offers it as a new one.
    await page.getByTestId('page-prompt-new').click();

    await expect(page.getByTestId('page-link-missing')).toBeVisible();
    await expect(page.getByTestId('page-link-missing')).toContainText(missingTitle);

    // Editing a placed block instead of deleting and making it again.
    await page.getByTestId('page-link-retarget').click();
    await page.getByTestId('block-prompt-input').fill(realTitle);
    await page.getByTestId(`page-prompt-option-${realId}`).click();

    await expect(page.getByTestId('page-link-card')).toContainText(realTitle);
  });

  test('the link menu suggests pages for text that is not an address', async ({ page }) => {
    const marker = Date.now().toString(36);
    const targetTitle = `Vorschlag ${marker}`;
    const targetId = await createPageWithTitle(page, targetTitle);

    await openEditor(page);
    await waitForCollaboration(page);
    await page.keyboard.type('Verweis ohne Klammern');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');

    await page.getByTestId('mark-link').click();
    // No brackets, no scheme: the field doubles as a page search.
    await page.getByTestId('link-input').fill(`Vorschlag ${marker}`);
    await page.getByTestId(`link-page-option-${targetId}`).click();

    await page.locator('.exocortex-editor a[data-link-kind="internal"]').click();
    await page.waitForURL(new RegExp(`/seite/${targetId}$`), { timeout: 30_000 });
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
  /**
   * Issue #29: inside a `contenteditable` the browser does not follow anchors,
   * so "this tab or a new one" is a decision the click handler has to read off
   * the event instead of deciding for the reader.
   */
  test('Strg-click on a link in the text opens it in a new tab', async ({ page, context }) => {
    const marker = Date.now().toString(36);
    const targetTitle = `Neuer Tab ${marker}`;
    const targetId = await createPageWithTitle(page, targetTitle);

    await openEditor(page);
    await waitForCollaboration(page);
    const documentUrl = page.url();

    await page.keyboard.type('Verweis mit Zusatztaste');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.getByTestId('mark-link').click();
    await page.getByTestId('link-input').fill(`[[${targetTitle}]]`);
    await page.getByTestId('link-apply').click();

    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page
        .locator('.exocortex-editor a[data-link-kind="internal"]')
        .click({ modifiers: ['ControlOrMeta'] }),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toContain(`/seite/${targetId}`);
    await popup.close();

    // And this tab stayed where it was, which is the whole point.
    expect(page.url()).toBe(documentUrl);
  });

  /**
   * Issue #24: a `[[Titel]]` in running text now carries the identity of its
   * target, so renaming the target no longer breaks it — the guarantee the
   * page-link block already had.
   */
  test('a [[Titel]] picked from the list survives its target being renamed', async ({ page }) => {
    const marker = Date.now().toString(36);
    const targetTitle = `Fließtext-Ziel ${marker}`;
    const renamedTitle = `Fließtext umbenannt ${marker}`;
    const targetId = await createPageWithTitle(page, targetTitle);

    await openEditor(page);
    await waitForCollaboration(page);
    await page.keyboard.type('Siehe dort');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');

    // Picking the page from the list is the moment the identity is known, and
    // therefore the moment it is written.
    await page.getByTestId('mark-link').click();
    await page.getByTestId('link-input').fill(targetTitle);
    await page.getByTestId(`link-page-option-${targetId}`).click();
    await waitForCollaboration(page);

    const sourceUrl = page.url();
    await page.goto(sourceUrl.replace(/\/seite\/[a-z0-9]+$/, `/seite/${targetId}`));
    const titleInput = page.getByTestId('document-title');
    await expect(titleInput).toHaveValue(targetTitle, { timeout: 15_000 });
    await titleInput.fill(renamedTitle);
    await titleInput.blur();
    await waitForCollaboration(page);

    await page.goto(sourceUrl);
    const link = page.locator('.exocortex-editor a[data-link-kind="internal"]');
    await expect(link).toBeVisible();
    // Not marked as dead, and it still lands on the page it always meant.
    await expect(link).not.toHaveClass(/exocortex-wiki-unresolved/);
    await link.click();
    await page.waitForURL(new RegExp(`/seite/${targetId}$`), { timeout: 30_000 });
  });

  test('a [[Titel]] nobody carries is marked as unresolved in the text', async ({ page }) => {
    const marker = Date.now().toString(36);

    await openEditor(page);
    await waitForCollaboration(page);
    await page.keyboard.type('Toter Verweis im Text');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.getByTestId('mark-link').click();
    await page.getByTestId('link-input').fill(`[[Es gibt mich nicht ${marker}]]`);
    await page.getByTestId('link-apply').click();

    await expect(page.locator('.exocortex-editor .exocortex-wiki-unresolved')).toBeVisible({
      timeout: 30_000,
    });
  });
});
