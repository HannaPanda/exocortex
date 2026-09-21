import { expect, type Page, test } from '@playwright/test';

import { requireSeedCredentials, workspaceIdFrom } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Issue #113: a settings form used to throw an afternoon's work away silently.
 *
 * The draft lives in the browser and is sent in one request, deliberately --
 * half of a hundred saved values would be worse than none. What was missing was
 * the other half of that bargain: a word that something is unsaved, and a
 * question before it is gone.
 *
 * Tested on the workspace form rather than the deployment one, because the seed
 * account is deliberately not a global admin. Both forms use the same guard.
 */
async function openWorkspaceSettings(page: Page): Promise<void> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const workspaceId = workspaceIdFrom(page);

  await page.goto(`/arbeitsbereich/${workspaceId}/einstellungen`);
  await page
    .getByTestId('workspace-settings-tabs')
    .getByRole('tab', { name: 'Einstellungen' })
    .click();
  await expect(page.getByTestId('workspace-setting-group-ai')).toBeVisible({ timeout: 30_000 });
}

/** The switch used throughout: one click is exactly one unsaved change. */
function toolsSwitch(page: Page) {
  return page.locator('#setting-ai-toolsEnabled');
}

test.describe('Ungespeicherte Einstellungen', () => {
  test('sagt sichtbar, dass etwas offen ist, und ist nach dem Verwerfen wieder still', async ({
    page,
  }) => {
    await openWorkspaceSettings(page);

    const notice = page.getByTestId('workspace-settings-dirty');
    await expect(notice).toBeEmpty();

    await toolsSwitch(page).click();
    await expect(notice).toHaveText('Eine Änderung ist noch nicht gespeichert.');

    // Bewusstes Verwerfen ist kein Datenverlust und fragt deshalb nicht nach.
    await page.getByRole('button', { name: 'Verwerfen' }).click();
    await expect(notice).toBeEmpty();
  });

  test('fragt nach, bevor ein Wechsel innerhalb der Anwendung die Änderung verwirft', async ({
    page,
  }) => {
    await openWorkspaceSettings(page);
    await toolsSwitch(page).click();
    await expect(page.getByTestId('workspace-settings-dirty')).not.toBeEmpty();

    await page.getByTestId('open-global-menu').click();
    await page.getByTestId('menu-help').click();

    const dialog = page.getByTestId('unsaved-changes-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Eine Einstellung ist geändert');

    // Hier bleiben lässt die Seite stehen, und die Änderung steht noch.
    await page.getByTestId('unsaved-changes-stay').click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/einstellungen$/);
    await expect(page.getByTestId('workspace-settings-dirty')).not.toBeEmpty();

    // Und derselbe Weg noch einmal, diesmal bis zum Ende.
    await page.getByTestId('open-global-menu').click();
    await page.getByTestId('menu-help').click();
    await page.getByTestId('unsaved-changes-leave').click();
    await page.waitForURL(/\/hilfe/, { timeout: 30_000 });
  });

  test('fragt nicht nach, wenn sich nichts geändert hat', async ({ page }) => {
    await openWorkspaceSettings(page);

    // Hin und zurück schalten ist effektiv keine Änderung.
    await toolsSwitch(page).click();
    await toolsSwitch(page).click();
    await expect(page.getByTestId('workspace-settings-dirty')).toBeEmpty();

    await page.getByTestId('open-global-menu').click();
    await page.getByTestId('menu-help').click();
    await page.waitForURL(/\/hilfe/, { timeout: 30_000 });
    await expect(page.getByTestId('unsaved-changes-dialog')).toHaveCount(0);
  });

  test('ist nach dem Speichern wieder sauber', async ({ page }) => {
    await openWorkspaceSettings(page);
    const notice = page.getByTestId('workspace-settings-dirty');

    await toolsSwitch(page).click();
    await expect(notice).not.toBeEmpty();
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByTestId('workspace-settings-saved')).toBeVisible({ timeout: 30_000 });
    await expect(notice).toBeEmpty();

    // Und der Wechsel geht jetzt ohne Rückfrage.
    await page.getByTestId('open-global-menu').click();
    await page.getByTestId('menu-help').click();
    await page.waitForURL(/\/hilfe/, { timeout: 30_000 });

    // Den eigenen Wert wieder wegräumen, damit der Arbeitsbereich bleibt, wie
    // er war.
    await openWorkspaceSettings(page);
    await page.getByTestId('workspace-setting-reset-ai.toolsEnabled').click();
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByTestId('workspace-settings-saved')).toBeVisible({ timeout: 30_000 });
  });
});
