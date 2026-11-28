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

  // The workspace's configuration is a group of the settings dialog now
  // (issue #279), opened over the workspace's start page.
  await page.goto(`/arbeitsbereich/${workspaceId}?einstellungen=overrides`);
  await expect(page.getByTestId('workspace-setting-group-ai')).toBeVisible({ timeout: 30_000 });
}

/** Another group of the dialog, which is the way out of a draft inside it. */
function languageGroup(page: Page) {
  return page.getByTestId('settings-nav-language');
}

/**
 * The e2e project is typed against Node alone, so a browser global is named
 * explicitly, and only as much of it as the callback touches.
 */
interface BrowserEvent {
  defaultPrevented: boolean;
}
interface BrowserWindow {
  Event: new (type: string, init: { cancelable: boolean }) => BrowserEvent;
  dispatchEvent: (event: BrowserEvent) => boolean;
}

/** The switch used throughout: one click is exactly one unsaved change. */
function toolsSwitch(page: Page) {
  return page.getByTestId('setting-row-ai.toolsEnabled').getByRole('switch');
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

  test('fragt nach, bevor ein Wechsel im Dialog die Änderung verwirft', async ({ page }) => {
    await openWorkspaceSettings(page);
    await toolsSwitch(page).click();
    await expect(page.getByTestId('workspace-settings-dirty')).not.toBeEmpty();

    await languageGroup(page).click();

    const dialog = page.getByTestId('unsaved-changes-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Eine Einstellung ist geändert');

    // Hier bleiben lässt die Gruppe stehen, und die Änderung steht noch.
    await page.getByTestId('unsaved-changes-stay').click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/einstellungen=overrides$/);
    await expect(page.getByTestId('workspace-settings-dirty')).not.toBeEmpty();

    // Und die Gruppe ist danach noch bedienbar.
    await toolsSwitch(page).click();
    await expect(page.getByTestId('workspace-settings-dirty')).toBeEmpty();
    await toolsSwitch(page).click();

    // Schließen fragt genauso, und Verwerfen schließt dann wirklich.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.getByTestId('unsaved-changes-leave').click();
    await expect(page.getByTestId('settings-dialog')).toHaveCount(0);
    await expect(page).not.toHaveURL(/einstellungen=/);
  });

  test('fragt nicht nach, wenn sich nichts geändert hat', async ({ page }) => {
    await openWorkspaceSettings(page);

    // Hin und zurück schalten ist effektiv keine Änderung.
    await toolsSwitch(page).click();
    await toolsSwitch(page).click();
    await expect(page.getByTestId('workspace-settings-dirty')).toBeEmpty();

    await languageGroup(page).click();
    await expect(page).toHaveURL(/einstellungen=language$/);
    await expect(page.getByTestId('unsaved-changes-dialog')).toHaveCount(0);
  });

  /**
   * Tab schließen und neu laden gehen nicht durch einen Klick auf einen Link,
   * sondern durch `beforeunload`. Ein echter Abbruch lässt sich im Browser
   * nicht auslesen, wohl aber, ob überhaupt jemand widerspricht: genau dann,
   * wenn etwas zu verlieren ist, und sonst nie.
   */
  test('widerspricht dem Schließen nur, solange etwas offen ist', async ({ page }) => {
    await openWorkspaceSettings(page);
    const guarded = async (): Promise<boolean> =>
      page.evaluate(() => {
        const browser = globalThis as unknown as BrowserWindow;
        const event = new browser.Event('beforeunload', { cancelable: true });
        browser.dispatchEvent(event);
        return event.defaultPrevented;
      });

    expect(await guarded()).toBe(false);
    await toolsSwitch(page).click();
    expect(await guarded()).toBe(true);
    // Hin und zurück ist effektiv keine Änderung, also auch kein Widerspruch.
    await toolsSwitch(page).click();
    expect(await guarded()).toBe(false);
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
    await languageGroup(page).click();
    await expect(page).toHaveURL(/einstellungen=language$/);
    await expect(page.getByTestId('unsaved-changes-dialog')).toHaveCount(0);

    // Den eigenen Wert wieder wegräumen, damit der Arbeitsbereich bleibt, wie
    // er war.
    await openWorkspaceSettings(page);
    await page.getByTestId('workspace-setting-reset-ai.toolsEnabled').click();
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(page.getByTestId('workspace-settings-saved')).toBeVisible({ timeout: 30_000 });
  });
});
