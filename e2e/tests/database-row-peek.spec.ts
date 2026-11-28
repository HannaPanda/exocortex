import { expect, type Page, test } from '@playwright/test';

import { createDatabase, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/** A database with `titles` as rows, made through the API; returns the ids. */
async function databaseWithRows(
  page: Page,
  baseURL: string | undefined,
  titles: readonly string[],
): Promise<{ databaseId: string; rowIds: Map<string, string> }> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const databaseId = await createDatabase(page, `Seitenleiste ${Date.now().toString(36)}`);
  await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });
  const headers = { origin: baseURL ?? '' };
  const rowIds = new Map<string, string>();
  for (const title of titles) {
    const response = await page.request.post(`/api/documents/${databaseId}/rows`, {
      headers,
      data: { title, values: [] },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const row = (await response.json()) as { document: { id: string } };
    rowIds.set(title, row.document.id);
  }
  await page.reload();
  await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(titles.length, {
    timeout: 15_000,
  });
  return { databaseId, rowIds };
}

function rowById(page: Page, rowId: string) {
  return page.getByTestId(`database-row-${rowId}`);
}

async function openByArrow(page: Page, rowId: string): Promise<void> {
  // The pinned title cell, not the middle of the row: with the panel open the
  // middle of a wide row lies under it.
  await rowById(page, rowId).locator('td').first().hover();
  await rowById(page, rowId).getByTestId('open-row-peek').click();
}

async function markdownOf(page: Page, documentId: string): Promise<string> {
  const response = await page.request.get(`/api/documents/${documentId}/export/markdown`);
  if (!response.ok()) return '';
  return ((await response.json()) as { markdown: string }).markdown;
}

test.describe('a row in the side panel (issue #239)', () => {
  test('opens beside the table, switches rows without losing text and closes back to the row', async ({
    page,
    baseURL,
  }) => {
    const titles = Array.from(
      { length: 30 },
      (_, index) => `Eintrag ${String(index + 1).padStart(2, '0')}`,
    );
    const { rowIds } = await databaseWithRows(page, baseURL, titles);
    const first = rowIds.get('Eintrag 25') as string;
    const second = rowIds.get('Eintrag 24') as string;
    const chosen = rowIds.get('Eintrag 03') as string;

    // A selection made before opening the panel survives it.
    await rowById(page, chosen).locator('td').first().hover();
    await rowById(page, chosen).getByTestId('row-select').click();
    await expect(page.getByTestId('selection-count')).toHaveText('1 ausgewählt');

    // Scrolled down to the row: opening the panel leaves the table where it is.
    await rowById(page, first).scrollIntoViewIfNeeded();
    // The table's two scroll containers: the page's and the table's own. The
    // panel brings a third, which is not the table's.
    const tableScrollers = page
      .locator('[data-testid="table-scroll"], .exocortex-page-scroll')
      .filter({ has: page.locator('[data-testid^="database-row-"]') });
    const scrollOf = () =>
      tableScrollers.evaluateAll((elements) =>
        elements.map((element) => (element as unknown as { scrollTop: number }).scrollTop),
      );
    const scrolledBefore = await scrollOf();
    expect(Math.max(...scrolledBefore)).toBeGreaterThan(0);

    const databaseUrl = page.url();
    await openByArrow(page, first);
    const peek = page.getByTestId('row-peek');
    await expect(peek).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`[?&]p=${first}`));
    await expect(peek.getByTestId('document-title')).toHaveValue('Eintrag 25', { timeout: 15_000 });
    await expect(peek.getByTestId('editor-surface')).toBeVisible({ timeout: 30_000 });
    expect(await scrollOf()).toEqual(scrolledBefore);
    // The context panel stays beside it, still about the database.
    await expect(page.getByTestId('context-tab-properties')).toBeVisible();

    // Written in the panel, then straight on to the next row.
    const text = `Notiz aus der Seitenleiste ${Date.now().toString(36)}`;
    await peek.getByTestId('editor-surface').click();
    await page.keyboard.type(text);
    await openByArrow(page, second);
    await expect(peek.getByTestId('document-title')).toHaveValue('Eintrag 24', { timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`[?&]p=${second}`));
    await expect.poll(() => markdownOf(page, first), { timeout: 30_000 }).toContain(text);

    // Escape closes it, the address loses the row, the focus is on the row
    // last shown, and the selection and the scroll position are untouched.
    await peek.getByTestId('document-title').click();
    await page.keyboard.press('Escape');
    await expect(peek).toHaveCount(0);
    await expect(page).toHaveURL(databaseUrl);
    await expect(rowById(page, second).getByTestId('open-row-peek')).toBeFocused();
    await expect(page.getByTestId('selection-count')).toHaveText('1 ausgewählt');
    await expect(rowById(page, chosen)).toHaveAttribute('data-state', 'selected');
    expect(await scrollOf()).toEqual(scrolledBefore);

    // The browser's Back closes the panel and stays on the database.
    await openByArrow(page, first);
    await expect(peek).toBeVisible({ timeout: 15_000 });
    await page.goBack();
    await expect(peek).toHaveCount(0);
    await expect(page).toHaveURL(databaseUrl);
    await expect(page.getByTestId('database-shell')).toBeVisible();

    // The address is the panel: a shared link opens the same row.
    await page.goto(`${databaseUrl}?p=${first}`);
    await expect(page.getByTestId('row-peek').getByTestId('document-title')).toHaveValue(
      'Eintrag 25',
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('row-peek')).toContainText(text, { timeout: 30_000 });

    // "Als ganze Seite öffnen" leaves the database for the row's own page.
    await page.getByTestId('row-peek-open-page').click();
    await expect(page).toHaveURL(new RegExp(`/seite/${first}$`), { timeout: 15_000 });
    await expect(page.getByTestId('database-shell')).toHaveCount(0);
  });

  test('opens a new row in the panel with its name ready to be typed over', async ({
    page,
    baseURL,
  }) => {
    await databaseWithRows(page, baseURL, ['Bestehend']);
    await page.getByTestId('add-row').click();
    const peek = page.getByTestId('row-peek');
    await expect(peek).toBeVisible({ timeout: 15_000 });
    const title = peek.getByTestId('document-title');
    await expect(title).toBeFocused({ timeout: 15_000 });

    // The name is selected: typing replaces it, Enter keeps it.
    const name = `Frisch ${Date.now().toString(36)}`;
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid^="database-row-"]', { hasText: name })).toHaveCount(1, {
      timeout: 15_000,
    });
    // The rename did not select the field again.
    await expect(title).toHaveValue(name);
    await expect(title).not.toBeFocused();

    // The handle menu's "Öffnen" is the same panel.
    await page.getByTestId('row-peek-close').click();
    await expect(peek).toHaveCount(0);
    const existing = page.locator('[data-testid^="database-row-"]', { hasText: 'Bestehend' });
    await existing.hover();
    await existing.getByTestId('row-handle').click();
    await page.getByTestId('row-open-peek').click();
    await expect(peek.getByTestId('document-title')).toHaveValue('Bestehend', { timeout: 15_000 });
  });

  test('opens a gallery card in the same panel', async ({ page, baseURL }) => {
    const { databaseId, rowIds } = await databaseWithRows(page, baseURL, ['Karte eins']);
    const response = await page.request.post(`/api/documents/${databaseId}/views`, {
      headers: { origin: baseURL ?? '' },
      data: { type: 'GALLERY', name: 'Galerie' },
    });
    expect(response.ok(), await response.text()).toBe(true);
    await page.reload();
    await page.getByRole('tab', { name: 'Galerie' }).click();
    await page.getByRole('link', { name: /Karte eins/ }).click();
    const peek = page.getByTestId('row-peek');
    await expect(peek.getByTestId('document-title')).toHaveValue('Karte eins', { timeout: 15_000 });
    await expect(page).toHaveURL(new RegExp(`[?&]p=${rowIds.get('Karte eins') ?? ''}`));
    // Still the gallery underneath.
    await expect(page.getByRole('tab', { name: 'Galerie' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  test('takes the whole page area on a phone', async ({ page, baseURL }) => {
    // Made at desktop width, where the sidebar's "new" button is in reach.
    const { rowIds } = await databaseWithRows(page, baseURL, ['Unterwegs']);
    await page.setViewportSize({ width: 390, height: 844 });
    await openByArrow(page, rowIds.get('Unterwegs') as string);
    const peek = page.getByTestId('row-peek');
    await expect(peek.getByTestId('document-title')).toHaveValue('Unterwegs', { timeout: 15_000 });
    const box = await peek.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(380);
    expect(box?.x ?? 99).toBeLessThanOrEqual(10);
    // Nothing to drag where the panel is the whole screen.
    await expect(page.getByTestId('row-peek-resize')).toHaveCount(0);
    await page.getByTestId('row-peek-close').click();
    await expect(peek).toHaveCount(0);
  });

  test('is as wide as it is dragged, by pointer and keys, within limits, and remembers it', async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    // A width a previous test may have left behind is not this test's start.
    await page.addInitScript(() => {
      if (sessionStorage.getItem('rowPeekWidthCleared') !== null) return;
      sessionStorage.setItem('rowPeekWidthCleared', '1');
      localStorage.removeItem('exocortex.rowPeek');
    });
    const { rowIds } = await databaseWithRows(page, baseURL, ['Breit']);
    await openByArrow(page, rowIds.get('Breit') as string);
    const peek = page.getByTestId('row-peek');
    await expect(peek.getByTestId('document-title')).toHaveValue('Breit', { timeout: 15_000 });
    const handle = page.getByTestId('row-peek-resize');
    await expect(handle).toHaveAttribute('role', 'separator');
    const widthOf = async () => Math.round((await peek.boundingBox())?.width ?? 0);
    const valueOf = async () => Number(await handle.getAttribute('aria-valuenow'));
    const defaultWidth = await widthOf();
    expect(defaultWidth).toBeGreaterThanOrEqual(416);
    expect(defaultWidth).toBeLessThanOrEqual(704);
    expect(await valueOf()).toBe(defaultWidth);

    // Dragged 150 px to the left by the mouse: 150 px wider.
    const box = await handle.boundingBox();
    if (box === null) throw new Error('no handle');
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 75, y, { steps: 5 });
    await page.mouse.move(box.x + box.width / 2 - 150, y, { steps: 5 });
    await page.mouse.up();
    const dragged = await widthOf();
    expect(Math.abs(dragged - (defaultWidth + 150))).toBeLessThanOrEqual(1);
    expect(await valueOf()).toBe(dragged);

    // The keys: the arrows step by 8 px, Home and End go to the limits.
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    expect(await widthOf()).toBe(dragged + 8);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await widthOf()).toBe(dragged - 8);
    await page.keyboard.press('Home');
    expect(await widthOf()).toBe(360);
    expect(await handle.getAttribute('aria-valuemin')).toBe('360');
    await page.keyboard.press('End');
    const max = Number(await handle.getAttribute('aria-valuemax'));
    expect(await widthOf()).toBe(max);
    // The table keeps its strip to the left of the panel.
    const peekBox = await peek.boundingBox();
    const area = await peek.evaluate((element) => {
      const parent = (
        element as unknown as { parentElement: { getBoundingClientRect(): { x: number } } }
      ).parentElement;
      return parent.getBoundingClientRect().x;
    });
    expect(Math.round((peekBox?.x ?? 0) - area)).toBeGreaterThanOrEqual(239);
    // Dragging past the limit stops at it.
    const atMax = await handle.boundingBox();
    if (atMax === null) throw new Error('no handle');
    await page.mouse.move(atMax.x + atMax.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(atMax.x + 1200, y, { steps: 8 });
    await page.mouse.up();
    expect(await widthOf()).toBe(360);

    // Remembered in this browser: a reload opens it at the width it was left.
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Escape');
    await expect(peek).toHaveCount(0);
    await openByArrow(page, rowIds.get('Breit') as string);
    await expect(peek.getByTestId('document-title')).toHaveValue('Breit', { timeout: 15_000 });
    await page.reload();
    await expect(peek.getByTestId('document-title')).toHaveValue('Breit', { timeout: 30_000 });
    expect(await widthOf()).toBe(392);

    // A double-click on the handle goes back to the default.
    await handle.dblclick();
    expect(await widthOf()).toBe(defaultWidth);
    await page.keyboard.press('Escape');
    await expect(peek).toHaveCount(0);
  });
});

test.describe('a database in the page tree (issue #221)', () => {
  test('shows its row count instead of its rows, and keeps a row that has sub-pages', async ({
    page,
    baseURL,
  }) => {
    const { databaseId, rowIds } = await databaseWithRows(page, baseURL, [
      'Zeile ohne Unterseite',
      'Zeile mit Unterseite',
    ]);
    const plainRow = rowIds.get('Zeile ohne Unterseite') as string;
    const branchRow = rowIds.get('Zeile mit Unterseite') as string;
    const workspaceId = /\/arbeitsbereich\/([a-z0-9]+)/.exec(page.url())?.[1] ?? '';

    const database = page.getByTestId(`tree-item-${databaseId}`);
    await expect(page.getByTestId(`tree-row-count-${databaseId}`)).toContainText('2');
    // Nothing to unfold: the rows live in the table.
    await expect(database.getByRole('button', { name: 'Unterseiten ausklappen' })).toBeHidden();

    // Opening a row unfolds nothing, and the path above the page says where it is.
    await page.goto(`/arbeitsbereich/${workspaceId}/seite/${plainRow}`);
    const path = page.getByRole('navigation', { name: 'Pfad' });
    await expect(path).toContainText('Seitenleiste', { timeout: 30_000 });
    await expect(page.getByTestId(`tree-item-${databaseId}`)).toBeVisible();
    await expect(page.getByTestId(`tree-item-${plainRow}`)).toHaveCount(0);

    // A row with a page of its own is a branch: it stays under its database.
    const created = await page.request.post(`/api/workspaces/${workspaceId}/documents`, {
      headers: { origin: baseURL ?? '' },
      data: { title: 'Notizen zur Zeile', parentId: branchRow },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const subPage = ((await created.json()) as { id: string }).id;
    await page.goto(`/arbeitsbereich/${workspaceId}/seite/${subPage}`);
    await expect(page.getByTestId(`tree-item-${subPage}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`tree-item-${branchRow}`)).toBeVisible();
    await expect(page.getByTestId(`tree-item-${plainRow}`)).toHaveCount(0);
    await expect(page.getByTestId(`tree-row-count-${databaseId}`)).toContainText('2');
  });
});
