import { expect, test } from '@playwright/test';

import { requireSeedCredentials, workspaceIdFrom } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * The knowledge map (issue #189): the room without the page tree, the
 * assistant beside it, and a canvas the engine actually drew into.
 */
test.describe('knowledge map', () => {
  test('opens as a room of its own with the assistant beside it', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const workspaceId = workspaceIdFrom(page);

    await page.goto(`/arbeitsbereich/${workspaceId}/karte`);
    await expect(page.getByTestId('knowledge-map')).toBeVisible();
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
    await expect(page.getByTestId('toggle-sidebar')).toHaveCount(0);
    await expect(page.getByTestId('context-panel')).toBeVisible();

    // The engine adds its own canvas once the library has loaded.
    await expect(page.getByTestId('knowledge-map-canvas').locator('canvas').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('heading', { name: 'Wissenskarte' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('map-activity')).toBeVisible();
  });

  test('lets a kind of line be switched off from the legend', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const workspaceId = workspaceIdFrom(page);
    await page.goto(`/arbeitsbereich/${workspaceId}/karte`);

    const link = page.getByTestId('map-kind-link');
    await expect(link).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await link.click();
    await expect(link).toHaveAttribute('aria-pressed', 'false');
  });

  test('keeps a tuned look across a reload and goes back to the default', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const workspaceId = workspaceIdFrom(page);
    await page.goto(`/arbeitsbereich/${workspaceId}/karte`);

    await page.getByTestId('map-appearance-toggle').click({ timeout: 30_000 });
    const panel = page.getByTestId('map-appearance');
    await expect(panel).toBeVisible();

    const halo = panel.getByRole('slider', { name: 'Lichthof' });
    await halo.focus();
    await halo.press('ArrowRight');
    await halo.press('ArrowRight');
    await expect(panel.getByRole('status')).toHaveText('Gespeichert', { timeout: 10_000 });

    await page.reload();
    await page.getByTestId('map-appearance-toggle').click({ timeout: 30_000 });
    const reset = page.getByTestId('map-appearance-reset');
    await expect(reset).toBeEnabled();
    await reset.click();
    await expect(page.getByTestId('map-appearance').getByRole('status')).toHaveText('Standard');
    await expect(reset).toBeDisabled();
  });
});
