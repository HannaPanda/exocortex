import { expect, type Page } from '@playwright/test';

interface BrowserDocument {
  document: {
    fonts: { ready: Promise<unknown> };
    querySelector: (selector: string) => unknown;
  };
}

/**
 * Opens a styleguide page and waits until it is the page a person would see.
 *
 * The heading alone is not enough: it is prerendered, so it is visible long
 * before React has hydrated, and until then a Base UI checkbox has no
 * `aria-labelledby` (it is wired in a layout effect) and a scan reports it as
 * nameless. A labelled checkbox is therefore the hydration signal. The fonts
 * are self-hosted and swapped in, so a screenshot taken before they are ready
 * would compare fallback metrics.
 */
export async function openStyleguide(
  page: Page,
  viewport: { width: number; height: number },
  path = '/design-system',
): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Designsystem' })).toBeVisible();
  await page.waitForFunction(() =>
    (globalThis as unknown as BrowserDocument).document.querySelector(
      '[data-slot="checkbox"][aria-labelledby]',
    ),
  );
  await page.evaluate(() => (globalThis as unknown as BrowserDocument).document.fonts.ready);
}

/** For a frame route: it has no heading and no checkbox, so it waits for the network to settle. */
export async function openFrame(page: Page, path: string): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => (globalThis as unknown as BrowserDocument).document.fonts.ready);
}

export const DESKTOP = { width: 1280, height: 800 };
export const NARROW = { width: 390, height: 844 };
