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
 * The decisions of 2026-09-24 (P9, P11, P12, P13, issue #126), checked where
 * they now live: the canonical sections, drawn by the product's own
 * components. A phone-width frame must really have a phone-width window.
 */
test.describe('design system decisions', () => {
  test('marks editor blocks without a left accent border', async ({ page }) => {
    await page.goto('/design-system#markierte-bloecke');
    const section = page.locator('section#markierte-bloecke');
    const commented = section.locator('.exocortex-commented');
    await expect(commented).toHaveCSS('border-left-width', '0px');
    await expect(commented.locator('.exocortex-comment-count')).toContainText('2');
    await expect(section.locator('.exocortex-transclusion')).toHaveCSS('border-left-width', '1px');
  });

  test('draws one focus ring and no outline', async ({ page }) => {
    await page.goto('/design-system#fokus');
    const section = page.locator('section#fokus');
    await section.getByRole('button', { name: 'Knopf' }).focus();
    await page.keyboard.press('Tab');
    const field = section.getByRole('textbox', { name: 'Feld' });
    await expect(field).toBeFocused();
    await expect(field).toHaveCSS('outline-style', 'none');
    await expect(field).not.toHaveCSS('box-shadow', 'none');

    // A link has no ring of its own; the base layer gives it the same one.
    const link = section.getByRole('link', { name: 'Ein Link' });
    await link.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    await expect(link).toHaveCSS('outline-style', 'none');
    await expect(link).not.toHaveCSS('box-shadow', 'none');
  });

  test('takes a select as the way out of an empty state', async ({ page }) => {
    await page.goto('/design-system#zustand-leer');
    const section = page.locator('section#zustaende');
    await expect(section.getByText('Noch nicht gruppiert')).toBeVisible();
    await expect(section.getByRole('combobox', { name: 'Gruppieren nach' })).toBeVisible();
  });

  test('turns a table into a list and keeps settings inside a phone', async ({ page }) => {
    await page.goto('/design-system#tabelle-schmal');
    const frame = page.locator('[data-testid="ds-frame-tabelle-liste"]');
    const width = await frame.evaluate(
      (element) =>
        (element as unknown as { contentWindow: { innerWidth: number } }).contentWindow.innerWidth,
    );
    expect(width).toBeLessThanOrEqual(390);
    expect(width).toBeGreaterThan(370);

    const list = page.frameLocator('[data-testid="ds-frame-tabelle-liste"]');
    await expect(list.getByRole('columnheader', { name: 'Rechte' })).toBeHidden();
    await expect(list.getByRole('button', { name: /zurückziehen$/ })).toHaveCount(3);
    // The action shares the first line with the name instead of sitting off-screen.
    const scrolls = await list
      .locator('[data-slot="table-container"]')
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(scrolls).toBe(false);

    await page.goto('/design-system#einstellungszeile-schmal');
    const settings = page.frameLocator('[data-testid="ds-frame-einstellungen"]');
    await expect(settings.getByText(/Nicht gespeichert\./)).toBeVisible();
    const row = settings.getByTestId('setting-row-ai.enabled');
    const label = await row.locator('label').first().boundingBox();
    const toggle = await row.getByRole('switch').boundingBox();
    expect(label).not.toBeNull();
    expect(toggle).not.toBeNull();
    // On the label's line, not under it.
    expect(Math.abs((toggle?.y ?? 0) - (label?.y ?? 0))).toBeLessThan(16);
  });
});
