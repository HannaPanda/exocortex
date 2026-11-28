import { expect, test } from '@playwright/test';

import { createPage, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * A picture from the web becomes a file of the page (issue #212): the browser
 * half of `exo_attachment_upload_url`.
 *
 * The picture fetched is this deployment's own app icon, reached through its
 * public address: the server goes out and comes back in through nginx exactly
 * as it would for a photo on another host, and the test does not depend on
 * anybody else's site being up.
 */
test.describe('an image from the web', () => {
  test('lands as an attachment of the page and shows', async ({ page, baseURL }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Bild aus dem Netz ${Date.now().toString(36)}`);
    await expect(page.getByTestId('editor-surface')).toBeVisible();
    await page.getByTestId('editor-surface').click();

    await page.keyboard.type('/netz');
    await expect(page.getByTestId('slash-option-image-from-url')).toBeVisible();
    await page.getByTestId('slash-option-image-from-url').click();

    // A private address is refused, and the dialog stays open to correct it.
    const input = page.getByTestId('block-prompt-input');
    await input.fill('http://127.0.0.1/foto.png');
    await page.getByTestId('block-prompt-submit').click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(input).toBeVisible();

    const address = new URL('/icons/icon-192.png', baseURL ?? 'https://exocortex.app').toString();
    await input.fill(address);
    await page.getByTestId('block-prompt-submit').click();
    await expect(input).toBeHidden({ timeout: 30_000 });

    const image = page.getByTestId('editor-surface').locator('img[data-zoomable]').first();
    await expect(image).toHaveAttribute('src', /^\/api\/attachments\/[a-z0-9]+\/download/);
    await expect.poll(() => image.evaluate((element) => element.naturalWidth)).toBeGreaterThan(0);
  });
});
