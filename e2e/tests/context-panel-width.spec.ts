import { expect, type Page, test } from '@playwright/test';

import { requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/** What the page keeps beside the panel (`CONTEXT_PAGE_KEEPS`). */
const PAGE_KEEPS = 496;
const NAVIGATION = 272;

/**
 * Starts from a known layout once per test, not on every navigation: an init
 * script runs again on a reload, and the reload is what proves the width is
 * remembered.
 */
async function presetLayoutOnce(page: Page, context: { open: boolean; width: number }) {
  await page.addInitScript(
    ([sidebar, panel]: [string, string]) => {
      if (sessionStorage.getItem('contextWidthPreset') !== null) return;
      sessionStorage.setItem('contextWidthPreset', '1');
      localStorage.setItem('exocortex.sidebar', sidebar);
      localStorage.setItem('exocortex.context', panel);
    },
    [JSON.stringify({ open: true, width: NAVIGATION }), JSON.stringify(context)] as [
      string,
      string,
    ],
  );
}

/**
 * The context panel, and the chat in it, on a wide screen (issue #246): it
 * grows well past the old 520 px, the page keeps a readable width, the chat
 * keeps a readable measure, and the width is this browser's.
 */
test('widens the context panel on a wide screen, within limits, and remembers it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await presetLayoutOnce(page, { open: true, width: 336 });
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

  const panel = page.getByTestId('context-panel');
  const handle = page.getByTestId('context-panel-resize');
  await expect(handle).toHaveAttribute('role', 'separator', { timeout: 30_000 });
  const widthOf = async () => Math.round((await panel.boundingBox())?.width ?? 0);
  expect(await widthOf()).toBe(336);
  // The upper limit is what the page can give up, not a fixed 520.
  const max = Number(await handle.getAttribute('aria-valuemax'));
  expect(max).toBe(1920 - NAVIGATION - PAGE_KEEPS);

  // Dragged 500 px to the left by the mouse: 500 px wider.
  const box = await handle.boundingBox();
  if (box === null) throw new Error('no handle');
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 250, y, { steps: 5 });
  await page.mouse.move(box.x + box.width / 2 - 500, y, { steps: 5 });
  await page.mouse.up();
  expect(Math.abs((await widthOf()) - 836)).toBeLessThanOrEqual(1);

  // End goes to the limit, and the page keeps its readable width.
  await handle.focus();
  await page.keyboard.press('End');
  expect(await widthOf()).toBe(max);
  const main = await page.locator('#exocortex-main').boundingBox();
  expect(Math.round(main?.width ?? 0)).toBeGreaterThanOrEqual(PAGE_KEEPS);
  // The chat keeps the measure it has on the whole screen (max-w-3xl).
  const chat = await page.getByTestId('ai-panel').boundingBox();
  expect(Math.round(chat?.width ?? 0)).toBeLessThanOrEqual(768);

  // A smaller window draws it narrower without forgetting the width.
  await page.setViewportSize({ width: 1280, height: 1000 });
  await expect.poll(widthOf).toBe(1280 - NAVIGATION - PAGE_KEEPS);
  await page.setViewportSize({ width: 1920, height: 1000 });
  await expect.poll(widthOf).toBe(max);

  // Remembered in this browser.
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await widthOf()).toBe(260 + 32);
  await page.reload();
  await expect(handle).toBeVisible({ timeout: 30_000 });
  expect(await widthOf()).toBe(292);

  // A double-click goes back to the default.
  await handle.dblclick();
  expect(await widthOf()).toBe(336);
});

test('has no handle on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await presetLayoutOnce(page, { open: true, width: 700 });
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  await expect(page.getByTestId('context-panel')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('context-panel-resize')).toHaveCount(0);
});
