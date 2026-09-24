import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { DESKTOP, NARROW, openFrame, openStyleguide } from './open';

/**
 * Accessibility checks on the canonical surfaces (issue #127).
 *
 * axe covers what a machine can decide: names, roles, ARIA, label association,
 * contrast, landmarks and headings, against WCAG 2.2 A and AA. It cannot decide
 * whether a keyboard path makes sense, so the second half walks the patterns
 * whose keyboard behaviour is a contract (dialog, menu, tree, the row action
 * that looks hover-only). Neither replaces the manual rules in
 * docs/ui-system.md for composite widgets.
 */

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * The known exceptions: a rule, the elements it skips, and why. Keep it short.
 * An entry here is a finding somebody decided to live with, not one that went
 * away, and the rule still runs everywhere else.
 */
const EXCEPTIONS: readonly { rule: string; exclude: string; reason: string }[] = [
  {
    rule: 'scrollable-region-focusable',
    exclude: '[data-slot="app-page"]',
    // The page scroller. Chromium (since 130) and Firefox make a scroller
    // without focusable content keyboard-focusable on their own; a tabIndex on
    // AppPage would add a tab stop and a ring around the whole page on every
    // screen, for browsers that already do it. Safari is the gap this accepts.
    reason: 'page scroller, focusable by the browser',
  },
];

interface Finding {
  rule: string;
  impact: string | null | undefined;
  help: string;
  nodes: string[];
}

async function findings(builder: AxeBuilder): Promise<Finding[]> {
  const result = await builder.analyze();
  return result.violations.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    // Enough to find the element, not a page of markup.
    nodes: violation.nodes
      .slice(0, 5)
      .map((node) => `${node.target.join(' ')}: ${node.failureSummary ?? ''}`),
  }));
}

/** Every WCAG rule, then each excepted rule once more with its exclusion. */
async function scan(page: Page): Promise<void> {
  const excepted = EXCEPTIONS.map((exception) => exception.rule);
  const all = await findings(new AxeBuilder({ page }).withTags(WCAG_TAGS).disableRules(excepted));
  for (const exception of EXCEPTIONS) {
    all.push(
      ...(await findings(
        new AxeBuilder({ page }).withRules([exception.rule]).exclude(exception.exclude),
      )),
    );
  }
  expect(all).toEqual([]);
}

test.describe('styleguide accessibility scan', () => {
  test('the whole page at desktop width', async ({ page }) => {
    await openStyleguide(page, DESKTOP);
    await scan(page);
  });

  test('the whole page at phone width', async ({ page }) => {
    await openStyleguide(page, NARROW);
    await scan(page);
  });

  for (const probe of ['tabelle-liste', 'einstellungen'] as const) {
    test(`the phone-width frame ${probe}`, async ({ page }) => {
      await openFrame(page, `/design-system/rahmen/${probe}`);
      await scan(page);
    });
  }

  test('an open dialog', async ({ page }) => {
    await openStyleguide(page, DESKTOP);
    await page.getByRole('button', { name: 'Dialog öffnen' }).click();
    await expect(page.getByRole('dialog', { name: 'Seite umbenennen' })).toBeVisible();
    await scan(page);
  });
});

test.describe('styleguide keyboard', () => {
  test('a dialog takes focus, keeps it, and gives it back', async ({ page }) => {
    await openStyleguide(page, DESKTOP);
    const trigger = page.getByRole('button', { name: 'Dialog öffnen' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Seite umbenennen' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(':focus')).toHaveCount(1);

    // Round the whole dialog and a bit: focus never leaves it.
    for (let step = 0; step < 6; step += 1) {
      await page.keyboard.press('Tab');
      await expect(dialog.locator(':focus')).toHaveCount(1);
    }
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.locator(':focus')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('a menu opens from the keyboard, walks with arrows, and gives focus back', async ({
    page,
  }) => {
    await openStyleguide(page, DESKTOP);
    const trigger = page.getByRole('button', { name: 'Seitenaktionen' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('ArrowDown');
    const first = await menu.locator(':focus').textContent();
    await page.keyboard.press('ArrowDown');
    await expect(menu.locator(':focus')).toHaveCount(1);
    expect(await menu.locator(':focus').textContent()).not.toBe(first);

    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('the page tree keeps one tab stop and moves it with the arrows', async ({ page }) => {
    await openStyleguide(page, DESKTOP);
    const tree = page.getByRole('tree', { name: 'Beispielseiten' });
    const stops = tree.locator('[role="treeitem"][tabindex="0"]');
    await expect(stops).toHaveCount(1);

    await tree.getByRole('treeitem', { name: 'Projekte' }).focus();
    await page.keyboard.press('ArrowDown');
    const moved = tree.getByRole('treeitem', { name: 'Dissertation' });
    await expect(moved).toBeFocused();
    // Roving: the stop went with the focus, it was not added.
    await expect(stops).toHaveCount(1);
    await expect(moved).toHaveAttribute('tabindex', '0');

    // Tab leaves the tree instead of walking its rows.
    await page.keyboard.press('Tab');
    await expect(tree.locator(':focus')).toHaveCount(0);
  });

  test('the row actions that appear on hover are reachable without a mouse', async ({ page }) => {
    await openStyleguide(page, DESKTOP);
    const tree = page.getByRole('tree', { name: 'Beispielseiten' });
    await tree.getByRole('treeitem', { name: 'Projekte' }).focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Symbol ändern …' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tree.getByRole('treeitem', { name: 'Projekte' })).toBeFocused();
  });

  test('focus is visible on every stop of the focus example', async ({ page }) => {
    await openStyleguide(page, DESKTOP);
    const section = page.locator('section#fokus');
    await section.getByRole('button', { name: 'Knopf' }).focus();
    // A handful of stops in order; each one must draw the ring.
    for (let step = 0; step < 4; step += 1) {
      const focused = page.locator(':focus');
      await expect(focused).toHaveCount(1);
      await expect(focused).not.toHaveCSS('box-shadow', 'none');
      await page.keyboard.press('Tab');
    }
  });
});
