import { expect, type Locator, type Page, test } from '@playwright/test';

import { requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Die Kopfzeile, auf beiden Breiten (Issues #100 und die Kopfzeilen-Arbeit
 * danach).
 *
 * Zuerst war die rechte Gruppe eine Reihe aus zehn bis zwölf Icons ohne Umbruch
 * und ohne Breakpoint. Bei 360 CSS-Pixeln stand sie zur Hälfte außerhalb des
 * Bildschirms, und weil die Hülle `overflow-hidden` trägt, *scrollte* dabei
 * nichts: die Knöpfe waren einfach abgeschnitten und unerreichbar. Ein Test auf
 * `scrollWidth` hätte den Fehler also nie gesehen. Deshalb misst diese Suite
 * die Kästen der einzelnen Bedienelemente gegen den Viewport.
 *
 * Danach war dieselbe Reihe auf dem breiten Schirm immer noch da, und das war
 * derselbe Fehler eine Stufe leiser: neun abstrakte Glyphen, dauerhaft neben
 * der Seite, die jemand schreibt. Jetzt gibt es eine Form für beide Breiten,
 * und diese Suite hält fest, dass es genau eine bleibt.
 */
const PHONE = { width: 360, height: 740 };
const DESKTOP = { width: 1280, height: 720 };

/**
 * The e2e project is typed against Node alone, so a browser global is named
 * the way `presetPanelPreference` names one: explicitly, and only as much of
 * it as the callback touches.
 */
interface BrowserDocument {
  document: { documentElement: { scrollWidth: number; clientWidth: number } };
}

/** Jede Fläche hinter dem Kontomenü, mit ihrer Adresse. */
const AREAS = [
  { testId: 'open-features', label: 'Hilfe und Funktionen', href: '/hilfe' },
  { testId: 'open-chats', label: 'Chats', href: '/chats' },
  { testId: 'open-entities', label: 'Entitäten', href: '/entitaeten' },
  { testId: 'open-shared', label: 'Mit mir geteilt', href: '/geteilt' },
  { testId: 'open-memory', label: 'Gedächtnis', href: '/gedaechtnis' },
  { testId: 'open-api-tokens', label: 'Verbindungen', href: '/einstellungen/verbindungen' },
  {
    testId: 'open-notifications',
    label: 'Benachrichtigungen',
    href: '/einstellungen/benachrichtigungen',
  },
];

/** Was dauerhaft sichtbar bleiben darf, in Fokusreihenfolge. */
const PERMANENT = [
  'toggle-sidebar',
  'workspace-switcher',
  'open-capture',
  'connection-status',
  'toggle-context',
  'open-global-menu',
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

    for (const testId of PERMANENT) {
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
        `Konto und Bereiche (${newCount} neue Funktionen)`,
      );
    } else {
      // Nichts Neues heißt: kein Punkt, und das Etikett sagt es auch so.
      await expect(badge).toHaveCount(0);
      await expect(page.getByTestId('open-global-menu')).toHaveAttribute(
        'aria-label',
        'Konto und Bereiche',
      );
    }
  });
});

for (const [name, viewport] of [
  ['Hochformat', PHONE],
  ['breitem Schirm', DESKTOP],
] as const) {
  test.describe(`Kontomenü auf ${name}`, () => {
    test.use({ viewport });

    test('jede Fläche steht mit ihrem Namen im Menü und nirgends als Icon', async ({ page }) => {
      await openWorkspace(page);

      // Die alte Icon-Reihe gibt es auf keiner Breite mehr.
      for (const area of AREAS) {
        await expect(page.getByTestId(area.testId)).toHaveCount(0);
      }
      await expect(page.getByTestId('sign-out')).toHaveCount(0);

      await page.getByTestId('open-global-menu').click();
      for (const area of AREAS) {
        const item = page.getByTestId(`menu-${area.testId}`);
        await expect(item).toBeVisible();
        // `toContainText`, not `toHaveText`: the entry is an icon and a word, so
        // the text node begins with the space between them, and the count in
        // "Hilfe und Funktionen" follows it. The address below is what pins the
        // identity of the entry.
        await expect(item).toContainText(area.label);
        await expect(item).toHaveAttribute('href', area.href);
        await expectInsideViewport(item, viewport.width);
      }
      await expect(page.getByTestId('menu-sign-out')).toBeVisible();

      // Und ein Eintrag führt auch wirklich hin.
      await page.getByTestId('menu-open-entities').click();
      await page.waitForURL(/\/entitaeten/, { timeout: 30_000 });
    });

    /**
     * Das Testkonto ist bewusst kein globaler Administrator (siehe
     * `exocortex-e2e-runnable`), also darf ihm die Verwaltung gar nicht erst
     * angeboten werden. Vorher stand das Schild für jeden im Kopf und führte in
     * ein „Kein Zugriff".
     */
    test('die Verwaltung wird einem Konto ohne Adminrolle nicht angeboten', async ({ page }) => {
      await openWorkspace(page);
      await page.getByTestId('open-global-menu').click();
      await expect(page.getByTestId('menu-open-features')).toBeVisible();
      await expect(page.getByTestId('menu-open-admin')).toHaveCount(0);
    });
  });
}

test.describe('Topbar auf breitem Schirm', () => {
  test.use({ viewport: DESKTOP });

  /**
   * Die Kopfzeile kostet auf dem Weg in den Text nur noch eine Handvoll
   * Tabstopps. Vorher waren es sechzehn, und jeder davon stand zwischen dem
   * Sprungziel und der Seite.
   */
  test('die Kopfzeile bleibt eine kurze Tabreihe und öffnet das Menü mit der Tastatur', async ({
    page,
  }) => {
    await openWorkspace(page);

    const menu = page.getByTestId('open-global-menu');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('open-search')).toBeVisible();

    const focusable = await page
      .locator('header button:visible, header a:visible, header [tabindex="0"]:visible')
      .count();
    expect(focusable, 'Die Kopfzeile hat wieder zu viele Tabstopps').toBeLessThanOrEqual(8);

    // Mit der Tastatur: fokussieren, öffnen, erster Eintrag, wieder zu.
    await menu.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('menu-open-features')).toBeVisible();
    await expect(page.getByTestId('menu-open-features')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('menu-open-chats')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('menu-open-features')).toHaveCount(0);
    await expect(menu).toBeFocused();
  });
});
