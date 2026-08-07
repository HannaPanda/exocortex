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
    await expect(page.getByTestId('trash-list')).toContainText(title);

    // An archived page is read-only.
    await page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
    await expect(page.getByTestId('archived-banner')).toBeVisible();

    await page.getByTestId('restore-document').click();
    await expect(page.getByTestId('archived-banner')).toBeHidden({ timeout: 30_000 });
    await expectTreeContains(page, title);
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
});
