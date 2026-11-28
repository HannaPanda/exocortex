import { expect, test } from '@playwright/test';

import { requireSeedCredentials, workspaceIdFrom } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Two defects that compile, pass every type check and are invisible to anything
 * but an eye on the screen.
 *
 * The first: Base UI's `Select.Value` renders the selected *value*, not the
 * selected item's text, so a closed select showed an id, a slug or an English
 * enum member wherever the two differed. The popup was always right, which is
 * why it survived so long -- only the closed control lied.
 *
 * The second: the tab component styled its selection with `data-selected`,
 * which Base UI's tab does not set (it sets `data-active`), so every tab list
 * in the application was drawn as if nothing were selected.
 *
 * Neither has a unit test that could have caught it, because in both cases the
 * markup was valid and the wrong thing was what a person saw. Hence a browser.
 */
test.describe('Auswahl und Navigation', () => {
  test('geschlossene Auswahlfelder zeigen die Beschriftung, nicht den Wert', async ({ page }) => {
    await page.goto('/gedaechtnis');
    await expect(page.getByRole('heading', { name: 'Gedächtnis', level: 1 })).toBeVisible({
      timeout: 60_000,
    });

    // `current` is the stored value; `gilt` is what a person is meant to read.
    const status = page.getByTestId('memory-status');
    await expect(status).toHaveText('gilt');

    // The workspace select is the same bug with an id instead of an enum
    // member: an id is a run of lowercase letters and digits with no space in
    // it, and no workspace of this deployment is named like that.
    const target = page.getByTestId('memory-target');
    await expect(target).not.toHaveText(/^[a-z0-9]{20,}$/);
    await expect(target).not.toBeEmpty();
  });

  test('die Einstellungen eines Arbeitsbereichs sind Gruppen, und genau eine ist gewählt', async ({
    page,
  }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const workspaceId = workspaceIdFrom(page);

    // The tabs became groups of the settings dialog (issue #279).
    await page.goto(`/arbeitsbereich/${workspaceId}?einstellungen=workspace`);
    const dialog = page.getByTestId('settings-dialog');
    const allgemein = dialog.getByTestId('settings-nav-workspace');
    const konfiguration = dialog.getByTestId('settings-nav-overrides');

    // Exactly one group carries the selection, and it is the one on screen.
    await expect(allgemein).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
    await expect(konfiguration).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('workspace-name-input')).toBeVisible();

    await konfiguration.click();
    await expect(konfiguration).toHaveAttribute('aria-current', 'page');
    await expect(allgemein).not.toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('workspace-name-input')).toHaveCount(0);

    // The settings themselves arrive one group at a time, and the group list
    // marks where you are for the same reason the navigation beside it does.
    const ai = page.getByTestId('workspace-setting-group-ai');
    const memory = page.getByTestId('workspace-setting-group-memory');
    await expect(ai).toHaveAttribute('data-active', '', { timeout: 30_000 });

    await memory.click();
    await expect(memory).toHaveAttribute('data-active', '');
    await expect(ai).not.toHaveAttribute('data-active', '');
  });
});
