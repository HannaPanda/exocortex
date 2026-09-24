import { expect, test } from '@playwright/test';

import { DESKTOP, NARROW, openStyleguide } from './open';

/**
 * Screenshot baselines of the canonical examples (issue #127).
 *
 * A curated set, not the whole page: each shot is one visual statement with a
 * real risk of drifting (a shared control, a pattern several surfaces reuse, a
 * layout with its own breakpoint), and no two shots say the same thing. A
 * section added to the styleguide does not need a shot; one that carries a
 * decision somebody would be unhappy to lose does.
 *
 * Deterministic by construction: the page draws only local fixtures, its
 * timestamps are offsets that always read the same ("vor 3 Tagen"), presence
 * colours are hashed from fixed ids, animations and the caret are switched off
 * by the config, and every shot waits for hydration and the self-hosted fonts
 * (`open.ts`).
 *
 * A red shot is a difference to review, not a verdict. See
 * `scripts/test-styleguide.sh` for the update step and when it is allowed.
 */

/** Shots of whole sections: the section is the unit the styleguide documents. */
const DESKTOP_SECTIONS = [
  // The swatches, so a token change is a visible, reviewed diff.
  'farben',
  'typografie',
  'fokus',
  'knoepfe',
  'formulare',
  'umschalter',
  'tabellen',
  'instrument',
  'zustaende',
  'markierte-bloecke',
  'einstellungszeile',
  'seitenbaum',
  'huelle',
] as const;

/** At phone width only what has its own breakpoint contract. */
const NARROW_SECTIONS = ['knoepfe', 'zustaende', 'huelle'] as const;

test.describe('styleguide screenshots, desktop', () => {
  for (const id of DESKTOP_SECTIONS) {
    test(`section ${id}`, async ({ page }) => {
      await openStyleguide(page, DESKTOP);
      await expect(page.locator(`section#${id}`)).toHaveScreenshot(`desktop-${id}.png`);
    });
  }

  test('a focused field', async ({ page }) => {
    await openStyleguide(page, DESKTOP);
    const section = page.locator('section#fokus');
    await section.getByRole('button', { name: 'Knopf' }).focus();
    await page.keyboard.press('Tab');
    const field = section.getByRole('textbox', { name: 'Feld' });
    await expect(field).toBeFocused();
    // The ring is drawn outside the field, so the shot takes a margin around it.
    const box = await field.boundingBox();
    expect(box).not.toBeNull();
    const margin = 8;
    await expect(page).toHaveScreenshot('desktop-focus-field.png', {
      clip: {
        x: (box?.x ?? 0) - margin,
        y: (box?.y ?? 0) - margin,
        width: (box?.width ?? 0) + 2 * margin,
        height: (box?.height ?? 0) + 2 * margin,
      },
    });
  });

  test('an open dialog', async ({ page }) => {
    await openStyleguide(page, DESKTOP);
    await page.getByRole('button', { name: 'Dialog öffnen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Seite umbenennen' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveScreenshot('desktop-dialog.png');
  });

  test('an open menu', async ({ page }) => {
    await openStyleguide(page, DESKTOP);
    await page.getByRole('button', { name: 'Seitenaktionen' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveScreenshot('desktop-menu.png');
  });

  test('an open popover', async ({ page }) => {
    await openStyleguide(page, DESKTOP);
    await page.getByRole('button', { name: 'Link einfügen' }).click();
    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover).toBeVisible();
    await expect(popover).toHaveScreenshot('desktop-popover.png');
  });
});

test.describe('styleguide screenshots, phone width', () => {
  for (const id of NARROW_SECTIONS) {
    test(`section ${id}`, async ({ page }) => {
      await openStyleguide(page, NARROW);
      await expect(page.locator(`section#${id}`)).toHaveScreenshot(`narrow-${id}.png`);
    });
  }

  test('a dialog, footer stacked', async ({ page }) => {
    await openStyleguide(page, NARROW);
    await page.getByRole('button', { name: 'Dialog öffnen' }).click();
    const dialog = page.getByRole('dialog', { name: 'Seite umbenennen' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveScreenshot('narrow-dialog.png');
  });

  // The narrow tables and the settings form are drawn in phone-width frames,
  // because their breakpoints answer to the window. The frame is shot at
  // desktop width: its inside is the phone, whatever the page around it is.
  for (const probe of ['tabelle-liste', 'einstellungen'] as const) {
    test(`frame ${probe}`, async ({ page }) => {
      await openStyleguide(page, DESKTOP);
      const frameElement = page.getByTestId(`ds-frame-${probe}`);
      await frameElement.scrollIntoViewIfNeeded();
      const inside = page.frameLocator(`[data-testid="ds-frame-${probe}"]`);
      await expect(inside.locator('body')).toBeVisible();
      await inside
        .locator('body')
        .evaluate(
          () =>
            (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document
              .fonts.ready,
        );
      await expect(frameElement).toHaveScreenshot(`narrow-frame-${probe}.png`);
    });
  }
});
