import { expect, type Locator, type Page, test } from '@playwright/test';

import { createPage, requireSeedCredentials, waitForCollaboration } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * Issue #229: the handle's menu acts on the block the handle stands beside.
 *
 * "Umwandeln in" changed the block holding the caret instead, and a colour did
 * nothing visible at all, because both worked on the selection and opening the
 * menu does not move it. Which selection stands for a block is unit-tested in
 * `packages/editor/src/block-target.test.ts`; what only a browser proves is
 * that the menu, the caret and `Strg+Z` agree on it.
 */
test.describe('the block menu', () => {
  async function pageWith(page: Page, markdown: string): Promise<void> {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    const documentId = await createPage(page, `Blockmenü ${Date.now().toString(36)}`);
    const write = await page.request.post(`/api/documents/${documentId}/content`, {
      data: { markdown: `${markdown}\n`, mode: 'replace' },
    });
    expect(write.ok(), await write.text()).toBe(true);
    await page.reload();
    await waitForCollaboration(page);
  }

  const textBlock = (page: Page, text: string): Locator =>
    page.locator('.exocortex-editor :is(p, h2)', { hasText: new RegExp(`^${text}$`) });

  /** Points at a block and opens the menu of the handle beside it. */
  async function openMenuOf(page: Page, block: Locator): Promise<void> {
    const box = await block.boundingBox();
    if (box === null) throw new Error('block has no layout');
    await page.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 6 });
    const handle = page.getByTestId('block-handle');
    await expect(handle).toBeVisible();
    await expect
      .poll(async () => {
        const at = await handle.boundingBox();
        return at === null ? Number.POSITIVE_INFINITY : Math.abs(at.y - box.y);
      })
      .toBeLessThan(6);
    await handle.click();
    await expect(page.getByTestId('block-duplicate')).toBeVisible();
  }

  /**
   * Points at the start of a block's text and travels to its handle the way a
   * hand does, frame by frame, checking at every step that the handle stays
   * beside that block; then presses and releases it (issue #286).
   */
  async function travelToHandleOf(page: Page, block: Locator): Promise<void> {
    const box = await block.boundingBox();
    if (box === null) throw new Error('block has no layout');
    const handle = page.getByTestId('block-handle');
    const handleOffset = async (): Promise<number> => {
      const at = await handle.boundingBox();
      return at === null ? Number.POSITIVE_INFINITY : Math.abs(at.y - box.y);
    };
    // Coming from the right, onto the first letters: the zone where the
    // handle used to go to the block around this one straight away.
    await page.mouse.move(box.x + 120, box.y + box.height / 2);
    await page.mouse.move(box.x + 6, box.y + box.height / 2, { steps: 6 });
    await expect(handle).toBeVisible();
    await expect.poll(handleOffset).toBeLessThan(6);
    const at = await handle.boundingBox();
    if (at === null) throw new Error('handle has no layout');
    const from = { x: box.x + 6, y: box.y + box.height / 2 };
    const to = { x: at.x + at.width / 2, y: at.y + at.height / 2 };
    const steps = 16;
    for (let step = 1; step <= steps; step += 1) {
      await page.mouse.move(
        from.x + ((to.x - from.x) * step) / steps,
        from.y + ((to.y - from.y) * step) / steps,
      );
      // Two frames: the plugin decides once per animation frame.
      await page.evaluate(() => {
        const frames = globalThis as unknown as {
          requestAnimationFrame: (callback: () => void) => number;
        };
        return new Promise<void>((resolve) => {
          frames.requestAnimationFrame(() => frames.requestAnimationFrame(resolve));
        });
      });
      expect(await handleOffset(), `step ${step} of ${steps}`).toBeLessThan(6);
    }
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.getByTestId('block-duplicate')).toBeVisible();
  }

  async function caretAtEndOf(page: Page, block: Locator): Promise<void> {
    await block.click();
    await page.keyboard.press('End');
  }

  test('turns the block beside the handle, not the one holding the caret', async ({ page }) => {
    await pageWith(page, ['Alpha', 'Beta', 'Gamma'].join('\n\n'));
    await expect(textBlock(page, 'Gamma')).toBeVisible({ timeout: 30_000 });

    await caretAtEndOf(page, textBlock(page, 'Alpha'));
    await openMenuOf(page, textBlock(page, 'Gamma'));
    await page.getByTestId('block-turn-into').click();
    await page.getByTestId('turn-into-heading-2').click();

    await expect(page.locator('.exocortex-editor h2')).toHaveCount(1);
    await expect(page.locator('.exocortex-editor h2')).toContainText('Gamma');
    await expect(page.locator('.exocortex-editor p', { hasText: 'Alpha' })).toHaveCount(1);
    // The caret went with the action: typing continues the changed block, and
    // no text selection is left behind to raise the formatting toolbar.
    await expect(page.getByTestId('selection-toolbar')).toBeHidden();
    await page.keyboard.type('!');
    await expect(page.locator('.exocortex-editor h2')).toContainText('Gamma!');

    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await expect(page.locator('.exocortex-editor h2')).toHaveCount(0);
    await expect(textBlock(page, 'Gamma')).toHaveCount(1);
  });

  test('colours the whole block beside the handle', async ({ page }) => {
    await pageWith(page, ['Alpha', 'Beta zwei Wörter'].join('\n\n'));
    await expect(textBlock(page, 'Beta zwei Wörter')).toBeVisible({ timeout: 30_000 });

    await caretAtEndOf(page, textBlock(page, 'Alpha'));
    await openMenuOf(page, textBlock(page, 'Beta zwei Wörter'));
    await page.getByTestId('block-color').click();
    await page.getByTestId('text-color-red').click();

    const red = page.locator('.exocortex-editor [data-text-color="red"]');
    await expect(red).toHaveCount(1);
    await expect(red).toHaveText('Beta zwei Wörter');
    await expect(page.getByTestId('selection-toolbar')).toBeHidden();

    await page.keyboard.press('Control+z');
    await expect(red).toHaveCount(0);
    await expect(textBlock(page, 'Beta zwei Wörter')).toHaveCount(1);
  });

  test('reaches a list item, a nested item and a quote', async ({ page }) => {
    await pageWith(
      page,
      ['Oben', '- Eins\n- Zwei\n  - Unter', '> Zitat eins\n>\n> Zitat zwei'].join('\n\n'),
    );
    await expect(textBlock(page, 'Unter')).toBeVisible({ timeout: 30_000 });
    await caretAtEndOf(page, textBlock(page, 'Oben'));

    // A nested item: only its own text turns green.
    await openMenuOf(page, textBlock(page, 'Unter'));
    await page.getByTestId('block-color').click();
    await page.getByTestId('text-color-green').click();
    await expect(page.locator('.exocortex-editor [data-text-color="green"]')).toHaveText('Unter');

    // An item of the outer list: the list it belongs to becomes numbered, the
    // sub-list keeps its points.
    await openMenuOf(page, textBlock(page, 'Zwei'));
    await page.getByTestId('block-turn-into').click();
    await page.getByTestId('turn-into-ordered-list').click();
    await expect(page.locator('.exocortex-editor ol > li > p', { hasText: 'Zwei' })).toHaveCount(1);
    await expect(page.locator('.exocortex-editor ol ul > li > p')).toHaveText('Unter');

    // A paragraph in a quote: the caret stayed in "Oben" throughout.
    await openMenuOf(page, textBlock(page, 'Zitat zwei'));
    await page.getByTestId('block-color').click();
    await page.getByTestId('text-background-yellow').click();
    await expect(
      page.locator('.exocortex-editor blockquote [data-text-background="yellow"]'),
    ).toHaveText('Zitat zwei');
    await expect(
      textBlock(page, 'Oben').locator('[data-text-color], [data-text-background]'),
    ).toHaveCount(0);
  });

  test('keeps the handle on a nested item while the pointer travels to it', async ({ page }) => {
    await pageWith(
      page,
      [
        'Oben',
        '- Eins\n  - Zwei\n    - Drei',
        '1. Alpha\n   1. Beta\n      1. Gamma',
        '- [ ] Aufgabe\n  - [ ] Teilaufgabe',
        '> Zitat eins\n>\n> Zitat zwei',
      ].join('\n\n'),
    );
    await expect(textBlock(page, 'Teilaufgabe')).toBeVisible({ timeout: 30_000 });

    for (const text of ['Zwei', 'Drei', 'Gamma', 'Teilaufgabe', 'Zitat zwei']) {
      await travelToHandleOf(page, textBlock(page, text));
      await page.getByTestId('block-color').click();
      await page.getByTestId('text-color-green').click();
      await expect(page.getByTestId('block-duplicate')).toBeHidden();
    }

    // The menu each time belonged to the item the pointer came from, never to
    // the item or the quote around it.
    await expect(page.locator('.exocortex-editor [data-text-color="green"]')).toHaveText([
      'Zwei',
      'Drei',
      'Gamma',
      'Teilaufgabe',
      'Zitat zwei',
    ]);
  });
  /**
   * Issue #284: "Absatz" on a list item makes it an ordinary line, splitting
   * the list around it and keeping its sub-items as a list underneath; the
   * other conversions take it out of its list the same way. Which blocks
   * come out is unit-tested beside `turnBlockInto`; this proves the real
   * menu, the caret and the collaborative undo agree.
   */
  test('turns a list item into a line, a heading or a quote', async ({ page }) => {
    await pageWith(
      page,
      [
        'Oben',
        '- Eins\n- Zwei\n  - Unter\n- Drei\n- Vier',
        '1. Alpha\n2. Beta\n3. Gamma',
        '- [ ] Aufgabe eins\n- [x] Aufgabe zwei\n- [ ] Aufgabe drei',
      ].join('\n\n'),
    );
    await expect(textBlock(page, 'Aufgabe drei')).toBeVisible({ timeout: 30_000 });
    await caretAtEndOf(page, textBlock(page, 'Oben'));

    const topLevel = (text: string, tag = 'p'): Locator =>
      page.locator(`.exocortex-editor .ProseMirror > ${tag}`, {
        hasText: new RegExp(`^${text}$`),
      });
    const listItem = (text: string): Locator =>
      page.locator('.exocortex-editor li p', { hasText: new RegExp(`^${text}$`) });
    async function turnInto(text: string, entry: string): Promise<void> {
      await openMenuOf(page, textBlock(page, text));
      await page.getByTestId('block-turn-into').click();
      await page.getByTestId(`turn-into-${entry}`).click();
      await expect(page.getByTestId('block-duplicate')).toBeHidden();
    }

    // In the middle, with a sub-item: the list splits around it, the sub-item
    // stays a list underneath, and one undo puts all of it back.
    await turnInto('Zwei', 'paragraph');
    await expect(topLevel('Zwei')).toHaveCount(1);
    await expect(listItem('Zwei')).toHaveCount(0);
    await expect(page.locator('.exocortex-editor .ProseMirror > ul')).toHaveCount(3);
    await expect(listItem('Unter')).toHaveCount(1);
    await expect(page.getByTestId('selection-toolbar')).toBeHidden();
    await page.keyboard.press('Control+z');
    await expect(listItem('Zwei')).toHaveCount(1);
    await expect(page.locator('.exocortex-editor .ProseMirror > ul')).toHaveCount(2);

    // The first and the last item; the caret ends after the line's text.
    await turnInto('Eins', 'paragraph');
    await expect(topLevel('Eins')).toHaveCount(1);
    await page.keyboard.type('!');
    await expect(topLevel('Eins!')).toHaveCount(1);
    await turnInto('Vier', 'paragraph');
    await expect(topLevel('Vier')).toHaveCount(1);
    await expect(listItem('Drei')).toHaveCount(1);

    // A numbered list and a task list split the same way.
    await turnInto('Beta', 'paragraph');
    await expect(topLevel('Beta')).toHaveCount(1);
    await expect(page.locator('.exocortex-editor .ProseMirror > ol')).toHaveCount(2);
    await turnInto('Aufgabe zwei', 'paragraph');
    await expect(topLevel('Aufgabe zwei')).toHaveCount(1);
    await expect(listItem('Aufgabe eins')).toHaveCount(1);
    await expect(listItem('Aufgabe drei')).toHaveCount(1);

    // Conversions that did nothing on a list item before, or hit its sub-item.
    await turnInto('Zwei', 'heading-2');
    await expect(topLevel('Zwei', 'h2')).toHaveCount(1);
    await expect(listItem('Unter')).toHaveCount(1);
    await turnInto('Drei', 'blockquote');
    await expect(
      page.locator('.exocortex-editor .ProseMirror > blockquote p', { hasText: /^Drei$/ }),
    ).toHaveCount(1);
    await expect(listItem('Drei')).toHaveCount(0);
  });
});
