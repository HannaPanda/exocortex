import { expect, type Locator, type Page, test } from '@playwright/test';

import { createDatabase, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

const LONG_TITLE = 'Steuerbescheid 2025 mit Anlage Kinderbetreuung und Belegen';
const MIN_WIDTH = 80;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 180;

interface Columns {
  databaseId: string;
  /** A number column whose values are short. */
  numberId: string;
  /** A text column holding one value far longer than any column may be wide. */
  noteId: string;
}

/** A database with a long row name, a short number column and an overlong text. */
async function databaseWithContent(page: Page, baseURL: string | undefined): Promise<Columns> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const databaseId = await createDatabase(page, `Spaltenbreite ${Date.now().toString(36)}`);
  await expect(page.getByTestId('add-property')).toBeVisible({ timeout: 15_000 });
  const headers = { origin: baseURL ?? '' };
  const create = async (type: string, name: string): Promise<string> => {
    const response = await page.request.post(`/api/documents/${databaseId}/properties`, {
      headers,
      data: { type, name },
    });
    expect(response.ok(), await response.text()).toBe(true);
    return ((await response.json()) as { id: string }).id;
  };
  const numberId = await create('NUMBER', 'Nr');
  const noteId = await create('TEXT', 'Notiz');
  for (const [title, number, note] of [
    [LONG_TITLE, 7, 'kurz'],
    ['Kurz', 12, 'Wort '.repeat(80).trim()],
  ] as const) {
    const response = await page.request.post(`/api/documents/${databaseId}/rows`, {
      headers,
      data: {
        title,
        values: [
          { propertyId: numberId, value: number },
          { propertyId: noteId, value: note },
        ],
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.reload();
  await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(2, { timeout: 15_000 });
  return { databaseId, numberId, noteId };
}

/** The width the view stores for one column, or undefined while it stores none. */
async function storedWidth(
  page: Page,
  databaseId: string,
  columnKey: string,
): Promise<number | undefined> {
  const response = await page.request.get(`/api/documents/${databaseId}/views`);
  expect(response.ok(), await response.text()).toBe(true);
  const { views } = (await response.json()) as {
    views: { config: { columnWidths?: Record<string, number> } }[];
  };
  return views[0]?.config.columnWidths?.[columnKey];
}

function header(page: Page, columnKey: string): Locator {
  return page.locator(`th[data-column-key="${columnKey}"]`);
}

/** How many lines a piece of text takes on screen. */
async function lineCount(text: Locator): Promise<number> {
  return text.evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
    return tops.size;
  });
}

test.describe('fitting a table column to its content (issue #277)', () => {
  test('a double-click, Enter and the column menu fit the width, and the view keeps it', async ({
    page,
    baseURL,
  }) => {
    const { databaseId, numberId, noteId } = await databaseWithContent(page, baseURL);

    // The long name wraps in the default width, so a fitted column is visibly
    // a different one: the whole name on one line.
    const longTitle = page.getByRole('link', { name: LONG_TITLE, exact: true });
    expect(await lineCount(longTitle)).toBeGreaterThan(1);

    // A double-click on the name column's divider.
    const titleHandle = header(page, 'title').getByTestId('column-resize');
    await header(page, 'title').hover();
    await titleHandle.dblclick();
    await expect
      .poll(() => storedWidth(page, databaseId, 'title'), { timeout: 15_000 })
      .toBeGreaterThan(DEFAULT_WIDTH);
    const titleWidth = (await storedWidth(page, databaseId, 'title')) ?? 0;
    expect(titleWidth).toBeLessThan(MAX_WIDTH);
    await expect.poll(() => lineCount(longTitle), { timeout: 15_000 }).toBe(1);
    await expect
      .poll(async () => Math.round((await header(page, 'title').boundingBox())?.width ?? 0))
      .toBe(titleWidth);

    // Enter on the focused divider of the short number column: narrower than
    // the default, never below the limit.
    await header(page, numberId).getByTestId('column-resize').focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(() => storedWidth(page, databaseId, numberId), { timeout: 15_000 })
      .toBeLessThan(DEFAULT_WIDTH);
    expect((await storedWidth(page, databaseId, numberId)) ?? 0).toBeGreaterThanOrEqual(MIN_WIDTH);

    // The column menu, on a text longer than any column may be: the limit.
    await page.getByTestId(`property-menu-${noteId}`).click();
    await page.getByTestId(`column-fit-${noteId}`).click();
    await expect
      .poll(() => storedWidth(page, databaseId, noteId), { timeout: 15_000 })
      .toBe(MAX_WIDTH);

    // Stored like a dragged width: a reload shows the same columns.
    await page.reload();
    await expect(page.locator('[data-testid^="database-row-"]')).toHaveCount(2, {
      timeout: 15_000,
    });
    await expect
      .poll(async () => Math.round((await header(page, noteId).boundingBox())?.width ?? 0))
      .toBe(MAX_WIDTH);
    expect(await lineCount(page.getByRole('link', { name: LONG_TITLE, exact: true }))).toBe(1);

    await page.request.delete(`/api/documents/${databaseId}`, {
      headers: { origin: baseURL ?? '' },
    });
  });
});
