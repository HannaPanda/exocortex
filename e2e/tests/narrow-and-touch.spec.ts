import { expect, type Page, test } from '@playwright/test';

import { requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * Zwei Dinge, die nur auf einem Telefon schiefgehen (Design-Review P2).
 *
 * Die Reiterleiste teilte ihre Breite gleichmäßig auf und schnitt ab, was nicht
 * passte: bei 390 Pixeln stand im Arbeitsbereich „Einstellunger“, und es gab
 * keine Geste, die den Rest gezeigt hätte. Und ein Tooltip ist eine
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
  await page.goto(`/arbeitsbereich/${workspaceId}/einstellungen`);
  await expect(page.getByTestId('workspace-settings-tabs')).toBeVisible({ timeout: 30_000 });
}

/** Jeder Reiter, der mehr Text hat als Platz, hat seine Beschriftung versteckt. */
async function clippedTabLabels(page: Page): Promise<string[]> {
  return page.getByTestId('workspace-settings-tabs').evaluate((list) => {
    const clipped: string[] = [];
    for (const tab of list.querySelectorAll('[role="tab"]')) {
      if (tab.scrollWidth > tab.clientWidth + 1) clipped.push(tab.textContent?.trim() ?? '?');
    }
    return clipped;
  });
}

test.describe('Reiterleiste auf Telefonbreite', () => {
  test.use({ viewport: PHONE });

  test('kein Reiter versteckt seine Beschriftung, die Leiste bricht stattdessen um', async ({
    page,
  }) => {
    await openWorkspaceSettings(page);

    expect(await clippedTabLabels(page)).toEqual([]);

    // Und der letzte Reiter ist auch wirklich benutzbar, nicht nur lesbar.
    await page.getByRole('tab', { name: 'Einstellungen' }).click();
    await expect(page.getByRole('tab', { name: 'Einstellungen' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

test.describe('Reiterleiste auf breitem Schirm', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('bleibt eine Zeile und teilt den Platz weiter gleichmäßig auf', async ({ page }) => {
    await openWorkspaceSettings(page);
    expect(await clippedTabLabels(page)).toEqual([]);

    const rows = await page.getByTestId('workspace-settings-tabs').evaluate((list) => {
      const tops = new Set<number>();
      for (const tab of list.querySelectorAll('[role="tab"]')) {
        tops.add(Math.round(tab.getBoundingClientRect().top));
      }
      return tops.size;
    });
    expect(rows).toBe(1);
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
