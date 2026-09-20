import { expect, type Locator, type Page, test } from '@playwright/test';

import { requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Die Topbar auf Telefonbreite (Issue #100).
 *
 * Die rechte Gruppe war eine Reihe aus zehn bis zwölf Icons ohne Umbruch und
 * ohne Breakpoint. Bei 360 CSS-Pixeln stand sie zur Hälfte außerhalb des
 * Bildschirms, und weil die Hülle `overflow-hidden` trägt, *scrollte* dabei
 * nichts: die Knöpfe waren einfach abgeschnitten und unerreichbar. Ein Test auf
 * `scrollWidth` hätte den Fehler also nie gesehen. Deshalb misst diese Suite
 * die Kästen der einzelnen Bedienelemente gegen den Viewport.
 *
 * Dieselbe Frage wie im Kontextbereich auf Minimalbreite (`activity-diff`):
 * keine Reihe beschrifteter Ziele in eine enge Zeile, Aktionen ins Menü.
 */
const PHONE = { width: 360, height: 740 };

/**
 * The e2e project is typed against Node alone, so a browser global is named
 * the way `presetPanelPreference` names one: explicitly, and only as much of
 * it as the callback touches.
 */
interface BrowserDocument {
  document: { documentElement: { scrollWidth: number; clientWidth: number } };
}

/** Jede Fläche, die im Breiten ein eigenes Icon hat, mit ihrem Menü-Eintrag. */
const AREAS = [
  { testId: 'open-features', label: /^Hilfe und Funktionen/, href: '/hilfe' },
  { testId: 'open-chats', label: 'Chats', href: '/chats' },
  { testId: 'open-entities', label: 'Entitäten', href: '/entitaeten' },
  { testId: 'open-shared', label: 'Mit mir geteilt', href: '/geteilt' },
  { testId: 'open-memory', label: 'Gedächtnis', href: '/gedaechtnis' },
  { testId: 'open-admin', label: 'Verwaltung', href: '/admin' },
  { testId: 'open-api-tokens', label: 'Verbindungen', href: '/einstellungen/verbindungen' },
];

async function openWorkspace(page: Page): Promise<void> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  await expect(page.getByTestId('workspace-switcher')).toBeVisible({ timeout: 30_000 });
}

/** Nichts an diesem Element darf rechts oder links aus dem Viewport ragen. */
async function expectInsideViewport(locator: Locator, width: number): Promise<void> {
  const box = await locator.boundingBox();
  const name = await locator.getAttribute('data-testid');
  if (box === null) throw new Error(`${name ?? 'Das Element'} ist nicht gelayoutet`);
  expect(box.x, `${name ?? 'Element'} ragt links hinaus`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${name ?? 'Element'} ragt rechts hinaus`).toBeLessThanOrEqual(
    width + 1,
  );
}

test.describe('Topbar im Hochformat', () => {
  test.use({ viewport: PHONE });

  test('kein Bedienelement der Topbar steht außerhalb des Bildschirms', async ({ page }) => {
    await openWorkspace(page);

    for (const testId of [
      'toggle-sidebar',
      'workspace-switcher',
      'open-capture',
      'connection-status',
      'toggle-context',
      'open-global-menu',
    ]) {
      const element = page.getByTestId(testId);
      await expect(element).toBeVisible();
      await expectInsideViewport(element, PHONE.width);
    }

    // Die Seite scrollt auch nicht waagerecht. Das ist hier die schwächere der
    // beiden Aussagen (die Hülle schneidet ab, statt zu scrollen), gehört aber
    // zu den Akzeptanzkriterien.
    const scrolls = await page.evaluate(() => {
      const root = (globalThis as unknown as BrowserDocument).document.documentElement;
      return root.scrollWidth > root.clientWidth;
    });
    expect(scrolls).toBe(false);
  });

  test('die Icon-Reihe weicht einem Sammelmenü, das jede Fläche behält', async ({ page }) => {
    await openWorkspace(page);

    // Im Schmalen ist die Reihe fort ...
    for (const area of AREAS) {
      await expect(page.getByTestId(area.testId)).toBeHidden();
    }
    await expect(page.getByTestId('sign-out')).toBeHidden();

    // ... und jede Fläche steht mit ihrem Namen im Menü, Abmelden inbegriffen.
    await page.getByTestId('open-global-menu').click();
    for (const area of AREAS) {
      const item = page.getByTestId(`menu-${area.testId}`);
      await expect(item).toBeVisible();
      await expect(item).toHaveText(area.label);
      await expect(item).toHaveAttribute('href', area.href);
    }
    await expect(page.getByTestId('menu-sign-out')).toBeVisible();

    // Und ein Eintrag führt auch wirklich hin.
    await page.getByTestId('menu-open-entities').click();
    await page.waitForURL(/\/entitaeten/, { timeout: 30_000 });
  });

  test('der Hinweis auf neue Funktionen bleibt ohne Öffnen des Menüs sichtbar', async ({
    page,
  }) => {
    await openWorkspace(page);

    const badge = page.getByTestId('global-menu-badge');
    const response = await page.request.get('/api/features');
    expect(response.ok(), await response.text()).toBe(true);
    const { newCount } = (await response.json()) as { newCount: number };

    if (newCount > 0) {
      await expect(badge).toBeVisible();
      await expectInsideViewport(page.getByTestId('open-global-menu'), PHONE.width);
      await expect(page.getByTestId('open-global-menu')).toHaveAttribute(
        'aria-label',
        `Menü (${newCount} neue Funktionen)`,
      );
    } else {
      // Nichts Neues heißt: kein Punkt, und das Etikett sagt es auch so.
      await expect(badge).toHaveCount(0);
      await expect(page.getByTestId('open-global-menu')).toHaveAttribute('aria-label', 'Menü');
    }
  });
});

test.describe('Topbar auf breitem Schirm', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('die Icon-Reihe steht unverändert, das Sammelmenü nicht', async ({ page }) => {
    await openWorkspace(page);

    for (const area of AREAS) {
      const icon = page.getByTestId(area.testId);
      await expect(icon).toBeVisible();
      await expect(icon).toHaveAttribute('href', area.href);
      await expectInsideViewport(icon, 1280);
    }
    await expect(page.getByTestId('sign-out')).toBeVisible();
    await expect(page.getByTestId('open-global-menu')).toBeHidden();
  });
});
