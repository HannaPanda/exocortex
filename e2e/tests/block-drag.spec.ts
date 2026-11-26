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
