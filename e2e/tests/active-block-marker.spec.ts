import { expect, type Locator, type Page, test } from '@playwright/test';

import { requireSeedCredentials, waitForCollaboration, workspaceIdFrom } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * Issue #238: a hairline in the left margin beside the block the caret is in.
 *
 * What only a browser shows: the line stands beside the innermost text block
 * (a nested point, a table cell's paragraph, a code block), follows the caret
 * when it moves by keyboard, goes with the focus, moves no text, stays in the
 * margin on a phone, is absent on a page that is only read, and goes when the
 * reader switches it off. Which block counts is unit-tested in
 * `active-block-marker.test.ts`.
 */

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

const MARKDOWN = [
  '## Abschnitt mit Cursor',
  '',
  'Erster Absatz, in dem der Cursor beginnt.',
  '',
  '- Oben in der Liste',
  '  - Eine Ebene tiefer',
  '    - Ganz unten in der Liste',
  '',
  '| Spalte A | Spalte B |',
  '| --- | --- |',
  '| Zelle links | Zelle rechts |',
  '',
  '```js',
  'const eins = 1;',
  'const zwei = 2;',
  'const drei = 3;',
  '```',
  '',
  'Letzter Absatz unter allem.',
  '',
].join('\n');

async function openPage(page: Page): Promise<{ workspaceId: string; documentId: string }> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const workspaceId = workspaceIdFrom(page);
  const created = await page.request.post(`/api/workspaces/${workspaceId}/documents`, {
    data: { title: `Cursor am Rand ${Date.now().toString(36)}`, type: 'PAGE' },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id: documentId } = (await created.json()) as { id: string };
  const write = await page.request.post(`/api/documents/${documentId}/content`, {
    data: { markdown: MARKDOWN, mode: 'replace' },
  });
  expect(write.ok(), await write.text()).toBe(true);
  await page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
  await waitForCollaboration(page);
  await expect(paragraph(page, 'Letzter Absatz unter allem.')).toBeVisible({ timeout: 30_000 });
  return { workspaceId, documentId };
}

function paragraph(page: Page, text: string): Locator {
  return page.locator('.exocortex-editor-canvas p', { hasText: text }).last();
}

function marker(page: Page): Locator {
  return page.getByTestId('active-block-marker');
}

/** The line where it shows; none at all when it was never drawn. */
function shownMarker(page: Page): Locator {
  return page.locator('[data-testid="active-block-marker"][data-visible="true"]');
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function box(locator: Locator): Promise<Box> {
  const measured = await locator.boundingBox();
  if (measured === null) throw new Error('not laid out');
  return measured;
}

/** Waits until the line stands beside `block`: same top, same height. */
async function expectBeside(page: Page, block: Locator): Promise<void> {
  await expect(marker(page)).toHaveAttribute('data-visible', 'true');
  await expect
    .poll(async () => {
      const line = await box(marker(page));
      const target = await box(block);
      return [Math.round(line.y - target.y), Math.round(line.height - target.height)];
    })
    .toEqual([0, 0]);
}

/** Where the text column starts: the left edge of a top-level paragraph. */
async function textLeft(page: Page): Promise<number> {
  return (await box(paragraph(page, 'Erster Absatz'))).x;
}

test.describe('the caret marked in the margin', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.afterEach(async ({ request, baseURL }) => {
    await request.patch('/api/me/preferences', {
      data: { activeBlockMarker: true },
      headers: { origin: baseURL as string },
    });
  });

  test('stands beside the innermost block, follows the keys and goes with the focus', async ({
    page,
  }) => {
    await openPage(page);
    const first = paragraph(page, 'Erster Absatz');
    const before = await box(first);

    await first.click();
    await expectBeside(page, first);
    // Nothing moved: the line is drawn beside the text, not into it.
    expect(await box(first)).toEqual(before);
    const line = await box(marker(page));
    expect(line.width).toBe(2);
    // In the seam between the disclosure lane (20 px) and the handle.
    expect(Math.round((await textLeft(page)) - (line.x + line.width))).toBe(20);
    await expect(marker(page)).toHaveCSS('pointer-events', 'none');

    // By keyboard into the list: each point is its own block, the deepest one
    // too, and the line stays at the same distance from the text column.
    await page.keyboard.press('ArrowDown');
    await expectBeside(page, paragraph(page, 'Oben in der Liste'));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const deepest = paragraph(page, 'Ganz unten in der Liste');
    await expectBeside(page, deepest);
    expect((await box(marker(page))).x).toBe(line.x);

    // A table cell's paragraph, not the table.
    const cell = paragraph(page, 'Zelle rechts');
    await cell.click();
    await expectBeside(page, cell);

    // A code block as a whole.
    await page.locator('.exocortex-editor-canvas pre', { hasText: 'const zwei' }).click();
    await expect(marker(page)).toHaveAttribute('data-visible', 'true');
    const code = await box(page.locator('.exocortex-editor-canvas pre', { hasText: 'const zwei' }));
    const codeLine = await box(marker(page));
    expect(codeLine.y).toBeLessThanOrEqual(code.y + 1);
    expect(codeLine.y + codeLine.height).toBeGreaterThanOrEqual(code.y + code.height - 1);

    // A heading.
    const heading = page.locator('.exocortex-editor-canvas h2', {
      hasText: 'Abschnitt mit Cursor',
    });
    await heading.click();
    await expectBeside(page, heading);

    // The focus goes elsewhere: so does the line.
    await page.locator('.exocortex-editor-canvas').evaluate((element) => {
      (element as unknown as { blur: () => void }).blur();
    });
    await expect(marker(page)).toHaveAttribute('data-visible', 'false');
    await expect(marker(page)).toHaveCSS('opacity', '0');

    // And it comes back with it.
    await paragraph(page, 'Letzter Absatz').click();
    await expectBeside(page, paragraph(page, 'Letzter Absatz'));
  });

  test('is gone when the reader switches it off', async ({ page, request, baseURL }) => {
    await openPage(page);
    const off = await request.patch('/api/me/preferences', {
      data: { activeBlockMarker: false },
      headers: { origin: baseURL as string },
    });
    expect(off.ok(), await off.text()).toBe(true);
    await page.reload();
    await waitForCollaboration(page);
    await paragraph(page, 'Erster Absatz').click();
    await page.keyboard.type(' x');
    await page.waitForTimeout(300);
    await expect(shownMarker(page)).toHaveCount(0);
  });

  test('is never there on a page that is only read', async ({ page }) => {
    const { documentId } = await openPage(page);
    const archived = await page.request.post(`/api/documents/${documentId}/archive`);
    expect(archived.ok(), await archived.text()).toBe(true);
    await page.reload();
    await expect(paragraph(page, 'Erster Absatz')).toBeVisible({ timeout: 30_000 });
    await paragraph(page, 'Erster Absatz').click();
    await page.waitForTimeout(300);
    await expect(shownMarker(page)).toHaveCount(0);
  });
});

test.describe('the caret marked in the margin, on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('stays in the margin and clear of the text', async ({ page }) => {
    await openPage(page);
    const first = paragraph(page, 'Erster Absatz');
    await first.click();
    await expectBeside(page, first);
    const line = await box(marker(page));
    expect(line.x).toBeGreaterThanOrEqual(0);
    expect(line.x + line.width).toBeLessThanOrEqual((await textLeft(page)) - 16);
    const scrollWidth = await page
      .locator('.exocortex-page-scroll')
      .evaluate((element) => (element as unknown as { scrollWidth: number }).scrollWidth);
    const clientWidth = await page
      .locator('.exocortex-page-scroll')
      .evaluate((element) => (element as unknown as { clientWidth: number }).clientWidth);
    expect(scrollWidth).toBe(clientWidth);
  });
});
