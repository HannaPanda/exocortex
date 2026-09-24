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

/** So viel Browser, wie `countHeaderRows` anfasst, und keinen Halm mehr. */
interface BrowserHeader {
  document: {
    documentElement: { style: { fontSize: string } };
    querySelector: (selector: string) => {
      children: ArrayLike<{ getBoundingClientRect: () => { y: number; height: number } }>;
    } | null;
  };
}

/**
 * Wie viele Zeilen die Kopfzeile gerade belegt.
 *
 * Gezählt werden die Mitten der Bedienelemente, nicht ihre Oberkanten: in einer
 * Zeile stehen unterschiedlich hohe Dinge nebeneinander (ein 28 px hoher Knopf
 * neben einem 32 px hohen Feld), ihre Oberkanten liegen also zwei Pixel
 * auseinander, während ihre Mitten auf derselben Linie sitzen.
 *
 * Optional mit einer gesetzten Wurzel-Schriftgröße: das ist der härtere der
 * beiden Textzoom-Wege. Stellt jemand die Schriftgröße im Browser um, wandern
 * die Breakpoints in `rem` mit und die Leiste nimmt von selbst ihre schmale
 * Form an; wird nur die Wurzelgröße der Seite verdoppelt, verdoppelt sich alles
 * darin, während die Breakpoints stehen bleiben.
 */
async function countHeaderRows(page: Page, rootFontSize?: string): Promise<number> {
  return page.evaluate((fontSize) => {
    const doc = (globalThis as unknown as BrowserHeader).document;
    if (fontSize !== undefined) doc.documentElement.style.fontSize = fontSize;
    const header = doc.querySelector('[data-testid="topbar"]');
    if (header === null) throw new Error('Die Kopfzeile ist nicht gelayoutet');
    const centres: number[] = [];
    for (const child of Array.from(header.children)) {
      const box = child.getBoundingClientRect();
      if (box.height === 0) continue;
      const centre = box.y + box.height / 2;
      if (!centres.some((other) => Math.abs(other - centre) < 6)) centres.push(centre);
    }
    return centres.length;
  }, rootFontSize);
}

/** Jede Fläche hinter dem Kontomenü, mit ihrer Adresse. */
const AREAS = [
  { testId: 'open-features', label: 'Hilfe und Funktionen', href: '/hilfe' },
  { testId: 'open-chats', label: 'Chats', href: '/chats' },
  { testId: 'open-entities', label: 'Entitäten', href: '/entitaeten' },
  { testId: 'open-shared', label: 'Freigaben', href: '/geteilt' },
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

/**
 * Die Breite, an der die Leiste am meisten auf einmal einblendet: `sm` liegt
 * genau hier, und damit kamen Wortmarke und benanntes Suchfeld im selben Atemzug
 * dazu. Gemessen waren das 736 Pixel Inhalt in einem 640 Pixel breiten Fenster,
 * also zwei Zeilen, und zwar bis 756 px hinauf. Die Wortmarke wartet seither auf
 * `lg`: sie ist mit 234 px das Breiteste in der Leiste und sagt als Einzige
 * nichts, was man hier tun kann.
 */
test.describe('Kopfzeile an der Schwelle', () => {
  test.use({ viewport: { width: 640, height: 900 } });

  test('bleibt einzeilig, und bei 200 % Textzoom bei höchstens zwei Zeilen', async ({ page }) => {
    await openWorkspace(page);
    expect(await countHeaderRows(page), 'Die Kopfzeile bricht bei 640 px um').toBe(1);

    // Bei doppelter Schrift darf sie umbrechen, dafür trägt sie `flex-wrap`.
    // Drei Zeilen waren es vorher, 233 der 900 Pixel Fensterhöhe.
    expect(
      await countHeaderRows(page, '32px'),
      'Die Kopfzeile nimmt bei 200 % wieder drei Zeilen',
    ).toBeLessThanOrEqual(2);
  });
});

test.describe('Topbar auf breitem Schirm', () => {
  test.use({ viewport: DESKTOP });

  /**
   * Außerhalb eines Arbeitsbereichs wird gar keine Navigation gerendert. Der
   * Schalter dafür stand trotzdem in der Kopfzeile und tat auf Klick und auf
   * Strg + B nichts. Ein Bedienelement ohne Wirkung bringt Leuten bei, den
   * anderen daneben auch nicht zu trauen.
   */
  test('bietet den Navigationsschalter nur an, wo es eine Navigation gibt', async ({ page }) => {
    await openWorkspace(page);
    await expect(page.getByTestId('toggle-sidebar')).toBeVisible();

    await page.getByTestId('open-global-menu').click();
    await page.getByTestId('menu-open-features').click();
    await page.waitForURL(/\/hilfe$/);

    await expect(page.getByTestId('topbar')).toBeVisible();
    await expect(page.getByTestId('toggle-sidebar')).toHaveCount(0);
    // Und die Taste gehört hier wieder dem Browser, statt für eine Fläche
    // eingezogen zu werden, die nicht erscheinen kann.
    await page.keyboard.press('Control+b');
    await expect(page.getByTestId('sidebar')).toHaveCount(0);
  });

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

    // Scoped to the application bar: a page renders a `<header>` of its own,
    // and counting both would measure the wrong thing.
    const focusable = await page
      .getByTestId('topbar')
      .locator('button:visible, a:visible, [tabindex="0"]:visible')
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
