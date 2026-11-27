import { expect, type Locator, type Page, test } from '@playwright/test';

import { createPage, requireSeedCredentials, waitForCollaboration } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Issue #243: moving blocks and list items with the handle, and without it.
 *
 * Where a block may land and what landing does is unit-tested in
 * `packages/editor/src/block-drop.test.ts`. What only a browser proves is the
 * rest: that the handle belongs to the item under the pointer (it stuck to the
 * previous block on a list's first and last item), that a real drag reaches
 * the editor past the handle's menu, that a line shows where the block lands
 * and at which level, and that the drop does what the line said.
 */
test.describe('moving blocks', () => {
  async function pageWith(page: Page, markdown: string): Promise<void> {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const documentId = await createPage(page, `Verschieben ${Date.now().toString(36)}`);
    const write = await page.request.post(`/api/documents/${documentId}/content`, {
      data: { markdown: `${markdown}\n`, mode: 'replace' },
    });
    expect(write.ok(), await write.text()).toBe(true);
    // A fresh load, so no marker of the write sits in the document.
    await page.reload();
    await waitForCollaboration(page);
  }

  const paragraph = (page: Page, text: string): Locator =>
    page.locator('.exocortex-editor p', { hasText: new RegExp(`^${text}$`) });

  /** The list items' own texts, in document order, indented by depth. */
  async function outline(page: Page): Promise<string[]> {
    return page.locator('.exocortex-editor li > p').evaluateAll((nodes) =>
      nodes.map((node) => {
        let depth = 0;
        for (let element = node.parentElement; element !== null; element = element.parentElement) {
          if (element.tagName === 'LI') depth += 1;
        }
        return `${'  '.repeat(depth - 1)}${node.textContent ?? ''}`;
      }),
    );
  }

  /**
   * Points at a block's upper half, the way a person reaches for it, and
   * waits until the handle stands beside that block.
   */
  async function grabHandle(page: Page, block: Locator): Promise<{ x: number; y: number }> {
    const box = await block.boundingBox();
    if (box === null) throw new Error('block has no layout');
    // The upper half of a single line: exactly where the handle used to stay
    // with the block above.
    await page.mouse.move(box.x + 30, box.y + 4, { steps: 6 });
    const handle = page.getByTestId('block-handle');
    await expect(handle).toBeVisible();
    await expect
      .poll(async () => {
        const at = await handle.boundingBox();
        return at === null ? Number.POSITIVE_INFINITY : Math.abs(at.y - box.y);
      })
      .toBeLessThan(6);
    const at = await handle.boundingBox();
    if (at === null) throw new Error('handle has no layout');
    return { x: at.x + at.width / 2, y: at.y + at.height / 2 };
  }

  test('carries a list item to the top of its list, with a line where it lands', async ({
    page,
  }) => {
    await pageWith(page, ['Oben', '1. Eins\n2. Zwei\n3. Drei', 'Unten'].join('\n\n'));
    await expect(paragraph(page, 'Drei')).toBeVisible({ timeout: 30_000 });

    const handle = await grabHandle(page, paragraph(page, 'Drei'));
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    const eins = await paragraph(page, 'Eins').boundingBox();
    if (eins === null) throw new Error('no layout');
    await page.mouse.move(handle.x, eins.y + 3, { steps: 12 });

    // While it is carried: the item fades and a line stands above "Eins",
    // starting where the item's text starts.
    const line = page.getByTestId('block-drop-line');
    await expect(line).toBeVisible();
    await expect(page.locator('.exocortex-editor .exocortex-drag-source')).toHaveCount(1);
    const lineBox = await line.boundingBox();
    if (lineBox === null) throw new Error('line has no layout');
    expect(Math.abs(lineBox.x - eins.x)).toBeLessThan(3);
    expect(lineBox.y).toBeLessThan(eins.y + 1);
    // The handle's menu stays shut while something is being dragged, and so
    // does the formatting toolbar: it would stand right where the item lands
    // and take the drop.
    await expect(page.getByTestId('block-duplicate')).toHaveCount(0);
    await expect(page.getByTestId('selection-toolbar')).toBeHidden();

    await page.mouse.up();
    await expect(line).toHaveCount(0);
    await expect.poll(() => outline(page)).toEqual(['Drei', 'Eins', 'Zwei']);
    // One numbered list, so the numbers follow the new order.
    await expect(page.locator('.exocortex-editor ol')).toHaveCount(1);
    await expect(page.locator('.exocortex-editor .exocortex-drag-source')).toHaveCount(0);

    // One step back with Strg+Z.
    await paragraph(page, 'Unten').click();
    await page.keyboard.press('Control+z');
    await expect.poll(() => outline(page)).toEqual(['Eins', 'Zwei', 'Drei']);
  });

  test('nests a list item one level deeper when it is carried to the right', async ({ page }) => {
    await pageWith(page, ['- Eins\n- Zwei\n- Drei', 'Unten'].join('\n\n'));
    await expect(paragraph(page, 'Drei')).toBeVisible({ timeout: 30_000 });

    const handle = await grabHandle(page, paragraph(page, 'Drei'));
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    const zwei = await paragraph(page, 'Zwei').boundingBox();
    if (zwei === null) throw new Error('no layout');
    // Straight up into the lower half of "Zwei": the next item, same level.
    await page.mouse.move(handle.x, zwei.y + zwei.height - 4, { steps: 10 });
    const line = page.getByTestId('block-drop-line');
    await expect(line).toBeVisible();
    // The row it will follow is tinted.
    await expect(page.locator('.exocortex-editor .exocortex-drop-anchor')).toHaveText('Zwei');
    // The line's solid part starts at the level it lands on; the faint run to
    // its left only shows how far the reachable levels go.
    const solid = line.locator('span');
    const sameLevel = await solid.boundingBox();
    // One indentation to the right: a sub-item of "Zwei", and the line says so.
    await page.mouse.move(handle.x + 28, zwei.y + zwei.height - 4, { steps: 6 });
    await expect
      .poll(async () => (await solid.boundingBox())?.x ?? 0)
      .toBeGreaterThan((sameLevel?.x ?? 0) + 10);

    await page.mouse.up();
    await expect.poll(() => outline(page)).toEqual(['Eins', 'Zwei', '  Drei']);
  });

  test('splits a list where a paragraph is carried between two of its items', async ({ page }) => {
    await pageWith(page, ['Absatz', '1. Eins\n2. Zwei\n3. Drei', 'Unten'].join('\n\n'));
    await expect(paragraph(page, 'Zwei')).toBeVisible({ timeout: 30_000 });

    const handle = await grabHandle(page, paragraph(page, 'Absatz'));
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    const eins = await paragraph(page, 'Eins').boundingBox();
    const absatz = await paragraph(page, 'Absatz').boundingBox();
    if (eins === null || absatz === null) throw new Error('no layout');
    // Straight down into the lower half of "Eins", not moved sideways: the
    // paragraph stays at page level, so the line starts where it starts.
    await page.mouse.move(handle.x, eins.y + eins.height - 4, { steps: 12 });
    const line = page.getByTestId('block-drop-line');
    await expect(line).toBeVisible();
    await expect
      .poll(async () => {
        const solid = await line.locator('span').boundingBox();
        return solid === null ? Number.POSITIVE_INFINITY : Math.abs(solid.x - absatz.x);
      })
      .toBeLessThan(3);
    await page.mouse.up();

    // Two numbered lists with the paragraph between them, counting afresh.
    await expect
      .poll(() => page.locator('.exocortex-editor p').allTextContents())
      .toEqual(['Eins', 'Absatz', 'Zwei', 'Drei', 'Unten']);
    await expect(page.locator('.exocortex-editor ol')).toHaveCount(2);
    await expect(page.locator('.exocortex-editor > ol + p + ol')).toHaveCount(1);

    await page.waitForTimeout(800);
    await paragraph(page, 'Unten').click();
    await page.keyboard.press('Control+z');
    await expect(page.locator('.exocortex-editor ol')).toHaveCount(1);
    await expect
      .poll(() => page.locator('.exocortex-editor p').allTextContents())
      .toEqual(['Absatz', 'Eins', 'Zwei', 'Drei', 'Unten']);
  });

  test('moves a list item out of its list with Strg+Umschalt+Pfeil, and a quote line out of the quote', async ({
    page,
  }) => {
    await pageWith(page, ['Oben', '- Eins\n- Zwei', '> Zitat eins\n>\n> Zitat zwei'].join('\n\n'));
    await expect(paragraph(page, 'Eins')).toBeVisible({ timeout: 30_000 });

    // At the top of its list the item leaves it and becomes a paragraph.
    await paragraph(page, 'Eins').click();
    await page.keyboard.press('Control+Shift+ArrowUp');
    await expect.poll(() => outline(page)).toEqual(['Zwei']);
    await expect(page.locator('.exocortex-editor > p', { hasText: /^Eins$/ })).toHaveCount(1);
    // The caret came along: the next press passes the paragraph above.
    await page.keyboard.press('Control+Shift+ArrowUp');
    await expect
      .poll(() => page.locator('.exocortex-editor > p').allTextContents())
      .toEqual(['Eins', 'Oben']);

    await page.waitForTimeout(800);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+z');
    await expect.poll(() => outline(page)).toEqual(['Eins', 'Zwei']);

    // The last line of a quote leaves it downwards, and the quote stays.
    await paragraph(page, 'Zitat zwei').click();
    await page.keyboard.press('Control+Shift+ArrowDown');
    await expect(page.locator('.exocortex-editor blockquote p')).toHaveText(['Zitat eins']);
    await expect(page.locator('.exocortex-editor > p').last()).toHaveText('Zitat zwei');
  });

  /*
   * Issue #268: the menu opens when the handle is let go without moving, the
   * way Notion does it, never on the press that may start a drag. Before, it
   * opened on the press and stood in the way of the block being carried.
   */
  test('opens the handle menu on release, not on press, and not after a drag', async ({ page }) => {
    await pageWith(page, ['Oben', 'Mitte', 'Unten'].join('\n\n'));
    await expect(paragraph(page, 'Unten')).toBeVisible({ timeout: 30_000 });
    const menuItem = page.getByTestId('block-duplicate');

    // Pressed and held: nothing opens, however long the press lasts.
    let handle = await grabHandle(page, paragraph(page, 'Mitte'));
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    await page.waitForTimeout(400);
    await expect(menuItem).toHaveCount(0);
    // Let go without moving: that is a click, and the menu opens.
    await page.mouse.up();
    await expect(menuItem).toBeVisible();
    // A second click on the handle closes it again and does not reopen it.
    await page.mouse.click(handle.x, handle.y);
    await expect(menuItem).toHaveCount(0);

    // Carried and dropped: the block moves and the menu stays shut.
    handle = await grabHandle(page, paragraph(page, 'Unten'));
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    const oben = await paragraph(page, 'Oben').boundingBox();
    if (oben === null) throw new Error('no layout');
    await page.mouse.move(handle.x, oben.y + 3, { steps: 12 });
    await expect(page.getByTestId('block-drop-line')).toBeVisible();
    await page.mouse.up();
    await expect
      .poll(() => page.locator('.exocortex-editor p').allTextContents())
      .toEqual(['Unten', 'Oben', 'Mitte']);
    await page.waitForTimeout(400);
    await expect(menuItem).toHaveCount(0);

    // The keyboard opens it as before: Enter on the focused handle.
    await grabHandle(page, paragraph(page, 'Mitte'));
    await page.getByTestId('block-handle').focus();
    await page.keyboard.press('Enter');
    await expect(menuItem).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menuItem).toHaveCount(0);
  });

  test('moves a block with Strg+Umschalt+Pfeil and takes it back with Strg+Z', async ({ page }) => {
    await pageWith(page, ['1. Eins\n2. Zwei\n3. Drei', 'Unten'].join('\n\n'));
    await expect(paragraph(page, 'Zwei')).toBeVisible({ timeout: 30_000 });

    await paragraph(page, 'Zwei').click();
    await page.keyboard.press('Control+Shift+ArrowUp');
    await expect.poll(() => outline(page)).toEqual(['Zwei', 'Eins', 'Drei']);
    // The caret moved with the item, so the next press moves it again.
    await page.keyboard.press('Control+Shift+ArrowDown');
    await page.keyboard.press('Control+Shift+ArrowDown');
    await expect.poll(() => outline(page)).toEqual(['Eins', 'Drei', 'Zwei']);

    await page.waitForTimeout(800);
    await page.keyboard.press('Control+z');
    await expect.poll(() => outline(page)).not.toEqual(['Eins', 'Drei', 'Zwei']);
  });
});
