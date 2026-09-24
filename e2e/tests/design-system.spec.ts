import { expect, test } from '@playwright/test';

/**
 * The styleguide at /design-system (issue #125).
 *
 * Public, so no stored session: the page must work for somebody who has never
 * signed in. What these tests hold is the contract the later gates (#127) build
 * on -- it hydrates, every section the navigation promises exists, a deep link
 * lands, and the components on it are the live ones rather than pictures.
 */

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
    await page.getByRole('option', { name: 'Tabellen' }).click();
    await expect(page).toHaveURL(/#tabellen$/);
    // Nothing on the page may push it wider than the phone.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
