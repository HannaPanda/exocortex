import { expect, type Page, test } from '@playwright/test';

import { requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * Zwei Dinge, die nur auf einem Telefon schiefgehen (Design-Review P2).
 *
 * Die Reiterleiste teilte ihre Breite gleichmäßig auf und schnitt ab, was nicht
 * passte: bei 390 Pixeln stand im Arbeitsbereich „Einstellunger“, und es gab
 * keine Geste, die den Rest gezeigt hätte. Die Reiter sind heute Gruppen des
 * Einstellungsdialogs (Issue #279); geprüft wird dasselbe an seinen Listen. Und ein Tooltip ist eine
 * Hover-Geste: auf einem Gerät ohne Hover öffnet ihn die Berührung über den
 * Fokus und nichts schließt ihn wieder, sodass der Kasten den Pfad verdeckt.
 *
 * Beides wird hier gemessen statt betrachtet, weil beides eine Frage von
 * Pixeln und Medienabfragen ist, die kein Typcheck sieht.
 */

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

const PHONE = { width: 390, height: 844 };

/**
 * The e2e project is typed against Node alone, so the browser globals a
 * callback touches are named here rather than pulled in as `lib: dom` --
 * the same thing `topbar-narrow.spec.ts` does, for the same reason.
 */
interface BrowserGlobals {
  document: { querySelectorAll: (selector: string) => Iterable<object> };
  getComputedStyle: (node: object) => { display: string };
}

async function openWorkspaceSettings(page: Page): Promise<void> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const workspaceId = /\/arbeitsbereich\/([a-z0-9]+)/.exec(page.url())?.[1] ?? '';
  // The workspace settings are groups of the settings dialog (issue #279);
  // their configuration keeps its own row of setting groups.
  await page.goto(`/arbeitsbereich/${workspaceId}?einstellungen=overrides`);
  await expect(groupList(page)).toBeVisible({ timeout: 30_000 });
}

/** The row of setting groups inside the workspace's configuration. */
function groupList(page: Page) {
  return page.getByRole('tablist').filter({ has: page.getByTestId('workspace-setting-group-ai') });
}

/** Jeder Eintrag, der mehr Text hat als Platz, hat seine Beschriftung versteckt. */
async function clippedLabels(page: Page, selector: string): Promise<string[]> {
  return page.getByTestId('settings-dialog').evaluate((dialog, inner) => {
    const clipped: string[] = [];
    for (const item of dialog.querySelectorAll(inner)) {
      if (item.scrollWidth > item.clientWidth + 1) clipped.push(item.textContent?.trim() ?? '?');
    }
    return clipped;
  }, selector);
}

const GROUP_TABS = '[role="tablist"] [role="tab"]';
const DIALOG_NAV = '[data-testid^="settings-nav-"]';

test.describe('Gruppenleiste auf Telefonbreite', () => {
  test.use({ viewport: PHONE });

  test('kein Eintrag versteckt seine Beschriftung, die Leiste bricht stattdessen um', async ({
    page,
  }) => {
    await openWorkspaceSettings(page);

    expect(await clippedLabels(page, GROUP_TABS)).toEqual([]);

    // Und der letzte Eintrag ist auch wirklich benutzbar, nicht nur lesbar.
    const last = groupList(page).getByRole('tab').last();
    await last.click();
    await expect(last).toHaveAttribute('aria-selected', 'true');

    // Die Liste der Gruppen des Dialogs, die ein Telefon zuerst zeigt, ebenso.
    await page.getByTestId('settings-back-to-list').click();
    await expect(page.getByTestId('settings-nav-overrides')).toBeVisible();
    expect(await clippedLabels(page, DIALOG_NAV)).toEqual([]);
  });
});

test.describe('Gruppenleiste auf breitem Schirm', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('schneidet weder im Dialog noch in der Konfiguration etwas ab', async ({ page }) => {
    await openWorkspaceSettings(page);
    expect(await clippedLabels(page, GROUP_TABS)).toEqual([]);
    expect(await clippedLabels(page, DIALOG_NAV)).toEqual([]);
  });
});

test.describe('Tooltips auf einem Gerät ohne Hover', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('eine Berührung hinterlässt keinen Hinweis-Kasten auf dem Schirm', async ({ page }) => {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const toggle = page.getByTestId('toggle-sidebar');
    await expect(toggle).toBeVisible({ timeout: 30_000 });

    await toggle.tap();
    await page.waitForTimeout(600);

    // Der Knopf trägt seinen Namen weiterhin selbst -- der Tooltip war nie die
    // einzige Quelle, er war nur die, die nicht mehr wegging.
    await expect(toggle).toHaveAttribute('aria-label', /Navigation/);
    const visibleHints = await page.evaluate(() => {
      const globals = globalThis as unknown as BrowserGlobals;
      let count = 0;
      for (const node of globals.document.querySelectorAll('[data-slot="tooltip-content"]')) {
        if (globals.getComputedStyle(node).display !== 'none') count += 1;
      }
      return count;
    });
    expect(visibleHints).toBe(0);
  });
});
