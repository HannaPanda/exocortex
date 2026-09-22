import { expect, test } from '@playwright/test';

import { createPage, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * The order a stacked dialog footer is read in.
 *
 * `DialogFooter` used to carry the shadcn registry's `flex-col-reverse`, so on
 * a phone the destructive answer appeared directly under the sentence warning
 * about it while the DOM said the opposite -- and Tab moved focus upwards. One
 * class in `packages/ui` decides this for every dialog in the application, and
 * the next update of the registry source is exactly how it would come back.
 */
test.describe('Dialogfußzeile auf dem Telefon', () => {
  test('stellt die sichere Antwort über die gefährliche', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const title = `Fußzeile ${Date.now().toString(36)}`;
    await createPage(page, title);

    await page.getByTestId('document-actions').click();
    await page.getByTestId('archive-document').click();

    await page.setViewportSize({ width: 390, height: 844 });
    // The palette rather than the page tree: at this width the navigation is
    // collapsed and the trash is only reachable as a command (issue #115).
    await page.keyboard.press('Control+k');
    await page.keyboard.type('papier');
    await page.keyboard.press('Enter');

    const sheet = page.getByTestId('trash-sheet');
    await expect(sheet).toContainText(title, { timeout: 30_000 });
    await sheet.getByRole('checkbox', { name: `„${title}“ zum Löschen auswählen` }).click();
    await page.getByTestId('trash-delete').click();

    const confirm = page.getByTestId('trash-delete-confirm');
    await expect(confirm).toBeVisible();
    const cancel = page.getByRole('button', { name: 'Abbrechen' }).last();

    const confirmBox = await confirm.boundingBox();
    const cancelBox = await cancel.boundingBox();
    expect(cancelBox).not.toBeNull();
    expect(confirmBox).not.toBeNull();
    if (cancelBox === null || confirmBox === null) return;
    // Stacked, and the safe answer first -- which is also the order the two
    // stand in in the DOM, so the focus order agrees with the eye.
    expect(cancelBox.y).toBeLessThan(confirmBox.y);

    // And nothing is destroyed by leaving: the question is answered with the
    // safe half, and the page is still in the trash afterwards.
    await cancel.click();
    await expect(sheet).toContainText(title);
  });
});
