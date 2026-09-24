import { expect, test } from '@playwright/test';

/**
 * The styleguide at /design-system (issue #125).
 *
 * Public, so no stored session: the page must work for somebody who has never
 * signed in. What these tests hold is the contract the later gates (#127) build
 * on -- it hydrates, every section the navigation promises exists, a deep link
 * lands, and the components on it are the live ones rather than pictures.
 */

/** As much of the browser as the overflow check touches; e2e compiles without the DOM lib. */
interface BrowserDocument {
  document: { documentElement: { scrollWidth: number; clientWidth: number } };
}

test.describe('design system', () => {
  test('renders without a session and without an uncaught error', async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(`${error.name}: ${error.message}`));

    await page.goto('/design-system');
    await expect(page.getByRole('heading', { level: 1, name: 'Designsystem' })).toBeVisible();
    await expect(page).toHaveURL(/\/design-system$/);
    expect(failures).toEqual([]);
  });

  test('has a section for every entry in its navigation', async ({ page }) => {
    await page.goto('/design-system');
    const navigation = page.getByRole('navigation', { name: 'Designsystem' });
    const links = navigation.getByRole('link');
    const hrefs = await links.evaluateAll((anchors) =>
      anchors.map((anchor) => anchor.getAttribute('href')),
    );
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) {
      expect(href).toMatch(/^#/);
      await expect(page.locator(`section${href ?? ''}`)).toHaveCount(1);
    }
  });

  test('shows the tokens the stylesheet declares', async ({ page }) => {
    await page.goto('/design-system#farben');
    const colours = page.locator('section#farben');
    await expect(colours.getByText('--primary', { exact: true })).toBeVisible();
    await expect(colours.getByText('oklch(0.796 0.155 72)', { exact: true }).first()).toBeVisible();
  });

  test('opens a real dialog with the safe answer first', async ({ page }) => {
    await page.goto('/design-system#dialoge');
    await page.getByRole('button', { name: 'Dialog öffnen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Seite umbenennen' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('offers the sections as a jump list at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/design-system');
    await expect(page.getByRole('navigation', { name: 'Designsystem' })).toBeHidden();
    await page.getByRole('combobox', { name: 'Zu Abschnitt springen' }).click();
    await page.getByRole('option', { name: 'Tabellen', exact: true }).click();
    await expect(page).toHaveURL(/#tabellen$/);
    // Nothing on the page may push it wider than the phone.
    const overflow = await page.evaluate(() => {
      const root = (globalThis as unknown as BrowserDocument).document.documentElement;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('walks the sample page tree with the arrow keys', async ({ page }) => {
    await page.goto('/design-system#seitenbaum');
    const tree = page.getByRole('tree', { name: 'Beispielseiten' });
    const first = tree.getByRole('treeitem', { name: 'Projekte' });
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await expect(tree.getByRole('treeitem', { name: 'Dissertation' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(tree.getByRole('treeitem', { name: 'Leseliste' })).toBeFocused();
    // Enter opens the page, which here means selecting it: no link leaves the styleguide.
    await page.keyboard.press('Enter');
    await expect(tree.getByRole('treeitem', { name: 'Leseliste' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page).toHaveURL(/\/design-system#seitenbaum$/);
  });

  test('reaches a tree row menu without a right click', async ({ page }) => {
    await page.goto('/design-system#seitenbaum');
    const tree = page.getByRole('tree', { name: 'Beispielseiten' });
    await tree.getByRole('button', { name: 'Aktionen für „Leseliste“' }).click();
    await expect(page.getByRole('menuitem', { name: 'Symbol ändern …' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: 'Symbol ändern …' })).toBeHidden();
  });

  test('turns the shell panels into sheets at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/design-system#huelle');
    const shell = page.locator('section#huelle');
    await expect(shell.getByRole('heading', { name: 'Schmale Hülle' })).toBeVisible();
    await shell.getByRole('button', { name: 'Navigation ein- oder ausblenden' }).click();
    const sheet = page.getByRole('dialog', { name: 'Navigation' });
    await expect(sheet.getByRole('tree', { name: 'Seiten im Beispiel' })).toBeVisible();
  });
});

/**
 * The experiments (issue #126). What they must guarantee is that a variant can
 * be compared at all: both halves are there, they carry the same content, the
 * focus rule really differs under the keyboard, and a phone-width frame really
 * has a phone-width window.
 */
test.describe('design system experiments', () => {
  test('shows each accent border with and without the rule', async ({ page }) => {
    await page.goto('/design-system#experiment-p13');
    const section = page.locator('section#experiment-p13');
    const commented = section.locator('.exocortex-commented');
    await expect(commented).toHaveCount(2);
    await expect(commented.nth(0)).toHaveCSS('border-left-width', '2px');
    await expect(commented.nth(1)).toHaveCSS('border-left-width', '0px');
    const transclusions = section.locator('.exocortex-transclusion');
    await expect(transclusions.nth(0)).toHaveCSS('border-left-width', '2px');
    await expect(transclusions.nth(1)).toHaveCSS('border-left-width', '1px');
  });

  test('draws a different focus per variant under the keyboard', async ({ page }) => {
    await page.goto('/design-system#experiment-p11');
    const variant = (key: string) => page.locator(`[data-ds-focus="${key}"]`).first();

    await variant('outline').getByRole('button', { name: 'Speichern' }).first().focus();
    await page.keyboard.press('Tab');
    const outlined = variant('outline').getByRole('button', { name: 'Verwerfen' }).first();
    await expect(outlined).toBeFocused();
    await expect(outlined).toHaveCSS('outline-style', 'solid');

    await variant('ring').getByRole('button', { name: 'Speichern' }).first().focus();
    await page.keyboard.press('Tab');
    const ringed = variant('ring').getByRole('button', { name: 'Verwerfen' }).first();
    await expect(ringed).toBeFocused();
    await expect(ringed).toHaveCSS('outline-style', 'none');
    await expect(ringed).not.toHaveCSS('box-shadow', 'none');
  });

  test('keeps the forced focus snapshot out of the tab order', async ({ page }) => {
    await page.goto('/design-system#experiment-p11');
    const snapshots = page.locator('section#experiment-p11 [inert]');
    await expect(snapshots).toHaveCount(3);
    await expect(snapshots.first().getByRole('button')).toHaveCount(0);
  });

  test('offers the same action in both empty state shapes', async ({ page }) => {
    await page.goto('/design-system#experiment-p9');
    const section = page.locator('section#experiment-p9');
    await expect(section.getByRole('button', { name: 'Papierkorb schließen' })).toHaveCount(2);
    await expect(section.getByRole('button', { name: 'Suche zurücksetzen' })).toHaveCount(2);
    await expect(section.getByText('Der Papierkorb ist leer')).toHaveCount(2);
  });

  test('draws the dense variants in a window 390 px wide', async ({ page }) => {
    await page.goto('/design-system#experiment-p12');
    const list = page.frameLocator('[data-testid="ds-frame-p12-tabelle-b"]');
    await expect(
      list.getByRole('heading', { name: 'Nächtlicher Import aus dem Laborrechner' }),
    ).toBeVisible();
    await expect(list.getByRole('button', { name: 'Zurückziehen' })).toHaveCount(3);
    const width = await page
      .locator('[data-testid="ds-frame-p12-tabelle-b"]')
      .evaluate(
        (frame) =>
          (frame as unknown as { contentWindow: { innerWidth: number } }).contentWindow.innerWidth,
      );
    expect(width).toBeLessThanOrEqual(390);
    expect(width).toBeGreaterThan(370);

    const settings = page.frameLocator('[data-testid="ds-frame-p12-einstellungen-a"]');
    await expect(settings.getByText(/Nicht gespeichert\./)).toBeVisible();
  });
});
