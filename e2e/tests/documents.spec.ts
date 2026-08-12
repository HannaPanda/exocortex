import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  createPage,
  expectTreeContains,
  requireSeedCredentials,
  workspaceIdFrom,
} from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

test.describe('documents', () => {
  test('creates nested pages and renames them', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const parentTitle = `Eltern ${Date.now().toString(36)}`;
    const parentId = await createPage(page, parentTitle);

    // Create a child through the tree's inline action. The browser is already on
    // a `/seite/...` URL, so the wait has to be for a *different* document.
    const parentUrl = page.url();
    await page.getByTestId(`tree-item-${parentId}`).hover();
    await page.getByTestId(`tree-item-${parentId}`).getByRole('button', { name: /Unterseite/ }).click();
    await page.waitForURL((url) => url.toString() !== parentUrl && /\/seite\/[a-z0-9]+/.test(url.pathname));

    const childTitle = `Kind ${Date.now().toString(36)}`;
    await page.getByTestId('document-title').fill(childTitle);
    await page.getByTestId('document-title').blur();
    await expectTreeContains(page, childTitle);

    // The child is nested: its breadcrumb contains the parent.
    await expect(page.getByRole('navigation', { name: 'Pfad' })).toContainText(parentTitle);
  });

  /**
   * Issue #29: opening a subpage through a direct link left the tree folded, so
   * the "you are here" marking sat on a row nobody could see.
   */
  test('unfolds the path to the page a direct link opens', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const marker = Date.now().toString(36);
    const parentId = await createPage(page, `Baum-Eltern ${marker}`);

    const parentUrl = page.url();
    await page.getByTestId(`tree-item-${parentId}`).hover();
    await page
      .getByTestId(`tree-item-${parentId}`)
      .getByRole('button', { name: /Unterseite/ })
      .click();
    await page.waitForURL(
      (url) => url.toString() !== parentUrl && /\/seite\/[a-z0-9]+/.test(url.pathname),
    );
    const childUrl = page.url();
    const childId = childUrl.split('/').pop() as string;

    // Fold the parent by hand, then arrive at the child from somewhere else
    // entirely — the state a search hit or a link in the text produces.
    await page
      .getByTestId(`tree-item-${parentId}`)
      .getByRole('button', { name: 'Unterseiten einklappen' })
      .click();
    await expect(page.getByTestId(`tree-item-${childId}`)).toBeHidden();

    await page.goto(parentUrl);
    await page.goto(childUrl);

    await expect(page.getByTestId(`tree-item-${childId}`)).toBeVisible({ timeout: 30_000 });
  });

  test('archives and restores a page', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const title = `Archiv ${Date.now().toString(36)}`;
    const documentId = await createPage(page, title);
    const workspaceId = workspaceIdFrom(page);

    await page.getByTestId('document-actions').click();
    await page.getByTestId('archive-document').click();
    await page.waitForURL(new RegExp(`/arbeitsbereich/${workspaceId}$`));

    await page.getByTestId('toggle-trash').click();
    await expect(page.getByTestId('trash-sheet')).toContainText(title);

    // An archived page is read-only.
    await page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
    await expect(page.getByTestId('archived-banner')).toBeVisible();

    await page.getByTestId('restore-document').click();
    await expect(page.getByTestId('archived-banner')).toBeHidden({ timeout: 30_000 });
    await expectTreeContains(page, title);
  });

  /** Issue #31: the trash used to only grow. */
  test('deletes an archived page for good', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const title = `Endgültig ${Date.now().toString(36)}`;
    await createPage(page, title);

    await page.getByTestId('document-actions').click();
    await page.getByTestId('archive-document').click();

    await page.getByTestId('toggle-trash').click();
    const sheet = page.getByTestId('trash-sheet');
    await expect(sheet).toContainText(title);

    await sheet.getByRole('checkbox', { name: `„${title}“ zum Löschen auswählen` }).click();
    await page.getByTestId('trash-delete').click();
    await page.getByTestId('trash-delete-confirm').click();

    // Gone from the trash, and gone for good: nothing restores it.
    await expect(sheet).not.toContainText(title, { timeout: 30_000 });
  });

  /**
   * A 1×1 PNG, small enough to live here rather than as a checked-in binary.
   * The bytes matter: the API sniffs the type from them and rejects anything
   * that is not really an image.
   */
  const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  test('adds a cover, moves its crop and removes it again', async ({ page }) => {
    const path = join(mkdtempSync(join(tmpdir(), 'exo-cover-')), 'titelbild.png');
    writeFileSync(path, ONE_PIXEL_PNG);

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Titelbild ${Date.now().toString(36)}`);

    // A page without a cover offers the button and nothing else.
    await expect(page.getByTestId('add-cover')).toBeAttached();
    await expect(page.getByTestId('page-cover')).toHaveCount(0);

    await page.setInputFiles('[data-testid="cover-file-input"]', path);
    await expect(page.getByTestId('page-cover-image')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('page-cover-image')).toHaveAttribute(
      'style',
      /object-position:\s*50% 50%/,
    );
    // The cover asks for the downscaled copy. This 1×1 PNG is far too small for
    // one to have been made, so what comes back is the original — which is the
    // fallback the route promises.
    await expect(page.getByTestId('page-cover-image')).toHaveAttribute(
      'src',
      /\/download\?variant=preview$/,
    );

    // Repositioning is keyboard-reachable: the image itself is the slider.
    await page.getByTestId('reposition-cover').click();
    await page.getByRole('slider', { name: /Bildausschnitt/ }).focus();
    await page.keyboard.press('End');
    await page.getByTestId('save-cover-position').click();
    await expect(page.getByTestId('reposition-cover')).toBeAttached();
    await expect(page.getByTestId('page-cover-image')).toHaveAttribute(
      'style',
      /object-position:\s*50% 100%/,
    );

    // The crop survives a reload, so it was stored and not just drawn.
    await page.reload();
    await expect(page.getByTestId('page-cover-image')).toHaveAttribute(
      'style',
      /object-position:\s*50% 100%/,
    );

    await page.getByTestId('remove-cover').click();
    await expect(page.getByTestId('page-cover')).toHaveCount(0);
    await expect(page.getByTestId('add-cover')).toBeAttached();
  });

  test('gives a page a coloured symbol, an emoji, and takes it away again', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const documentId = await createPage(page, `Symbol ${Date.now().toString(36)}`);

    const treeIcon = page.getByTestId(`tree-icon-${documentId}`).locator('[data-icon]');

    // A page without a symbol shows the default one for its type, and offers the
    // button that gives it one.
    await expect(treeIcon).toHaveAttribute('data-icon', 'default');
    await page.getByTestId('add-page-icon').click();

    // The colour is picked first, then the symbol it applies to.
    await page.getByTestId('page-icon-color-blue').click();
    await page.getByTestId('page-icon-brain').click();

    await expect(page.getByTestId('page-icon-button')).toBeVisible();
    await expect(treeIcon).toHaveAttribute('data-icon', 'lucide:brain');
    await expect(treeIcon).toHaveClass(/text-content-blue/);

    // It survives a reload, so it was stored and not just drawn.
    await page.reload();
    await expect(treeIcon).toHaveAttribute('data-icon', 'lucide:brain');
    await expect(treeIcon).toHaveClass(/text-content-blue/);

    // An emoji replaces it and takes the colour with it: it brings its own.
    await page.getByTestId('page-icon-button').click();
    await page.getByTestId('page-icon-tab-emoji').click();
    await page.getByTestId('page-icon-emoji-🚀').click();
    await expect(treeIcon).toHaveAttribute('data-icon', '🚀');
    await expect(treeIcon).not.toHaveClass(/text-content-blue/);

    // And the tree's own symbol opens the same picker, which can clear it.
    await page.getByTestId(`tree-icon-${documentId}`).click();
    await page.getByTestId('page-icon-remove').click();
    await expect(treeIcon).toHaveAttribute('data-icon', 'default');
    await expect(page.getByTestId('add-page-icon')).toBeAttached();
  });

  /**
   * The picker offers every Lucide icon and every emoji, not the curated
   * shortlist it opens on. Both sets arrive in a chunk of their own, so this also
   * covers that the chunk is actually fetched when the picker is opened.
   */
  test('finds a symbol outside the curated shortlist by its German name', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const documentId = await createPage(page, `Suche ${Date.now().toString(36)}`);
    const treeIcon = page.getByTestId(`tree-icon-${documentId}`).locator('[data-icon]');

    // "rocket" is not in the curated set and is not a German word; both the full
    // icon set and the German synonym have to be in play for this to match.
    await page.getByTestId('add-page-icon').click();
    await page.getByTestId('page-icon-search').fill('rakete');
    await page.getByTestId('page-icon-rocket').click({ timeout: 15_000 });
    await expect(treeIcon).toHaveAttribute('data-icon', 'lucide:rocket');

    // Reload: the icon is drawn from the lazily loaded path data, not from the
    // static map, so this is where a missing loader would show up.
    await page.reload();
    await expect(treeIcon).toHaveAttribute('data-icon', 'lucide:rocket');
    await expect(page.getByTestId(`tree-icon-${documentId}`).locator('svg')).toBeVisible();

    // An emoji from outside the shortlist, found by its German label.
    await page.getByTestId(`tree-icon-${documentId}`).click();
    await page.getByTestId('page-icon-tab-emoji').click();
    await page.getByTestId('page-icon-search').fill('marienkäfer');
    await page.getByTestId('page-icon-emoji-🐞').click({ timeout: 15_000 });
    await expect(treeIcon).toHaveAttribute('data-icon', '🐞');
  });

  /**
   * Reordering pages (the keyboard half of dragging). Drag and drop itself is
   * native HTML5 and not driven reliably by Playwright, but both paths end in the
   * same `POST /api/documents/:id/move` with the same sibling anchors.
   */
  test('reorders and re-parents pages from the tree', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const marker = Date.now().toString(36);
    const firstId = await createPage(page, `Ordnung A ${marker}`);
    const secondId = await createPage(page, `Ordnung B ${marker}`);

    const rowIndex = async (documentId: string): Promise<number> => {
      const ids = await page
        .getByTestId('page-tree')
        .locator('[data-testid^="tree-item-"]')
        .evaluateAll((rows) =>
          rows.map((row) => row.getAttribute('data-testid')?.replace('tree-item-', '') ?? ''),
        );
      return ids.indexOf(documentId);
    };

    // Both are root pages, and the newer one was appended after the older one.
    expect(await rowIndex(firstId)).toBeLessThan(await rowIndex(secondId));

    // Move the second one up past the first.
    await page.getByTestId(`tree-item-${secondId}`).click({ button: 'right' });
    await page.getByTestId(`tree-move-up-${secondId}`).click();
    await expect
      .poll(async () => (await rowIndex(secondId)) < (await rowIndex(firstId)))
      .toBe(true);

    // Then make the lower one a child of the one above it, and check the nesting
    // survives a reload rather than living only in the optimistic update.
    await page.getByTestId(`tree-item-${firstId}`).click({ button: 'right' });
    await page.getByTestId(`tree-indent-${firstId}`).click();
    await page.reload();
    await expect(page.getByTestId(`tree-item-${firstId}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`tree-item-${firstId}`)).toHaveAttribute(
      'style',
      /padding-left:\s*1rem/,
    );

    // And back out to the top level again.
    await page.getByTestId(`tree-item-${firstId}`).click({ button: 'right' });
    await page.getByTestId(`tree-outdent-${firstId}`).click();
    await expect(page.getByTestId(`tree-item-${firstId}`)).toHaveAttribute(
      'style',
      /padding-left:\s*0.25rem/,
    );
  });

  test('keeps sidebar and context panel toggles working', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await expect(page.getByTestId('sidebar')).toBeVisible();
    await page.getByTestId('toggle-sidebar').click();
    await expect(page.getByTestId('sidebar')).toBeHidden();
    await page.getByTestId('toggle-sidebar').click();
    await expect(page.getByTestId('sidebar')).toBeVisible();

    await expect(page.getByTestId('context-panel')).toBeVisible();
    await page.getByTestId('toggle-context').click();
    await expect(page.getByTestId('context-panel')).toBeHidden();
  });

  /**
   * The context panel's "Eigenschaften" tab (issue #17): provenance, an
   * editable symbol distinct from the page header's own icon control, the AI
   * rule surfaced (not hidden away in its own dialog only), and the technical
   * details collapsed until asked for.
   */
  test('shows and edits page properties in the context panel', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const title = `Eigenschaften ${Date.now().toString(36)}`;
    const documentId = await createPage(page, title);

    await page.getByTestId('context-tab-properties').click();
    await expect(page.getByTestId('page-properties')).toBeVisible({ timeout: 15_000 });

    // Not a database row, so no row-property section.
    await expect(page.getByTestId('row-properties')).toHaveCount(0);

    // Provenance names who created the page -- Johanna, the signed-in seed user.
    await expect(page.getByTestId('provenance')).toContainText('Johanna');

    // Technical details start collapsed.
    await expect(page.getByTestId('materialized-at')).toHaveCount(0);
    await page.getByTestId('technical-section-toggle').click();
    await expect(page.getByTestId('materialized-at')).toBeVisible();

    // The panel's own symbol control is distinct from the page header's: both
    // can be on screen at once without colliding on the same test id.
    await page.getByTestId('properties-icon-button').click();
    await page.getByTestId('page-icon-color-blue').click();
    await page.getByTestId('page-icon-brain').click();
    await expect(page.getByTestId(`tree-icon-${documentId}`).locator('[data-icon]')).toHaveAttribute(
      'data-icon',
      'lucide:brain',
    );

    // The AI rule is visible without opening a separate menu, and editing it
    // reuses the existing "Seiteneigenschaften" dialog rather than a second
    // implementation of the same fields.
    await expect(page.getByTestId('open-ai-rule-from-properties')).toBeVisible();
    await page.getByTestId('open-ai-rule-from-properties').click();
    await expect(page.getByTestId('save-page-properties')).toBeVisible({ timeout: 15_000 });
  });
});
