import { expect, type Page, test } from '@playwright/test';

import { createPage, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

// Reuse the session created by the global setup instead of logging in again:
// sign-in is rate limited by design.
test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

/**
 * The editor's *reachability*, not its schema.
 *
 * The Markdown and schema layers are covered by unit tests in
 * `packages/editor`. What only a browser can prove is that the formatting exists
 * where a user can find it: a toolbar over a selection, a `/` menu, a block handle.
 * That is precisely what was missing before this suite existed.
 */
test.describe('editor', () => {
  /** Opens a fresh page and puts the caret in the editor. */
  async function openEditor(page: Page): Promise<void> {
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
    await createPage(page, `Editor ${Date.now().toString(36)}`);
    await expect(page.getByTestId('editor-surface')).toBeVisible();
    await page.getByTestId('editor-surface').click();
  }

  test('formats a selection through the toolbar', async ({ page }) => {
    await openEditor(page);

    await page.keyboard.type('Formatierung funktioniert');
    // Select the whole paragraph.
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');

    const toolbar = page.getByTestId('selection-toolbar');
    await expect(toolbar).toBeVisible();

    await page.getByTestId('mark-bold').click();
    await expect(page.locator('.exocortex-editor strong')).toHaveText('Formatierung funktioniert');

    // Re-select: applying a mark leaves the selection in place, but the assertion
    // above waited for a DOM change, and the toolbar has repositioned since.
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.getByTestId('mark-underline').click();
    await expect(page.locator('.exocortex-editor u')).toHaveCount(1);

    // The buttons report the state of the selection.
    await expect(page.getByTestId('mark-bold')).toHaveAttribute('data-pressed', '');
  });

  /**
   * The formatting bar is one Tab stop, not fourteen.
   *
   * This is what `role="toolbar"` promises a screen reader and a keyboard user,
   * and for a long time this bar could not keep the promise: Base UI 1.0.0-rc.0
   * swallowed the click of a `Toolbar.Button` that rendered our own `Button`, so
   * every control was a plain button outside the roving tabindex
   * (`docs/deviations.md` 17). The workaround is gone since 1.8.0, and this test
   * is what stops it coming back unnoticed: a roving tabindex means exactly one
   * control is reachable by Tab and the arrow keys move between them.
   */
  test('the selection toolbar is a single tab stop with arrow-key navigation', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type('Tastaturbedienung');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');

    const toolbar = page.getByTestId('selection-toolbar');
    await expect(toolbar).toBeVisible();

    const controls = toolbar.locator('button');
    await expect(controls.filter({ has: page.locator(':scope[tabindex="0"]') })).toHaveCount(1);
    expect(await controls.count()).toBeGreaterThan(1);

    // Arrow keys move the roving focus; Tab would leave the bar altogether.
    await page.getByTestId('mark-bold').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('mark-italic')).toBeFocused();
  });

  test('applies a text colour from the toolbar', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type('Farbiger Text');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');

    await page.getByTestId('color-trigger').click();
    await page.getByTestId('text-color-red').click();

    // The document stores the colour *name*, never a CSS value.
    await expect(page.locator('.exocortex-editor [data-text-color="red"]')).toHaveText(
      'Farbiger Text',
    );
  });

  test('inserts a block through the slash menu', async ({ page }) => {
    await openEditor(page);

    await page.keyboard.type('/');
    await expect(page.getByTestId('slash-menu')).toBeVisible();

    // Typing narrows the list; Enter takes the highlighted entry.
    await page.keyboard.type('aufgabe');
    await expect(page.getByTestId('slash-option-task-list')).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(page.locator('.exocortex-editor ul[data-type="taskList"]')).toHaveCount(1);
    await page.keyboard.type('Erste Aufgabe');
    await expect(page.getByTestId('editor-surface')).toContainText('Erste Aufgabe');
  });

  test('inserts a toggle through the slash menu', async ({ page }) => {
    await openEditor(page);

    await page.keyboard.type('/umschalt');
    await expect(page.getByTestId('slash-option-toggle')).toBeVisible();
    await page.getByTestId('slash-option-toggle').click();
    // The node view renders `div[data-type="details"]`; native `details` markup is
    // only produced by the HTML export.
    await expect(page.locator('.exocortex-editor [data-type="details"]')).toHaveCount(1);
  });

  test('inserts a table of contents through the slash menu', async ({ page }) => {
    await openEditor(page);

    await page.keyboard.type('/inhaltsver');
    await expect(page.getByTestId('slash-option-table-of-contents')).toBeVisible();
    await page.getByTestId('slash-option-table-of-contents').click();
    await expect(page.locator('.exocortex-editor nav[data-toc]')).toHaveCount(1);
  });

  test('converts a paragraph into a heading through the toolbar', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type('Wird eine Überschrift');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');

    await page.getByTestId('turn-into-trigger').click();
    await page.getByTestId('turn-into-heading-2').click();

    // `toContainText`, not `toHaveText`: a heading also carries the collapse
    // button of the collapsible-heading extension.
    await expect(page.locator('.exocortex-editor h2')).toContainText('Wird eine Überschrift');
  });

  test('duplicates and deletes a block through the block actions', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type('Ein Block');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');

    await page.getByTestId('block-actions-trigger').click();
    await page.getByTestId('block-duplicate').click();
    await expect(page.locator('.exocortex-editor p', { hasText: 'Ein Block' })).toHaveCount(2);

    // Duplicating moves the cursor into the copy and collapses the selection, so
    // the toolbar is gone; select again to reopen it.
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await expect(page.getByTestId('block-actions-trigger')).toBeVisible();
    await page.getByTestId('block-actions-trigger').click();
    await page.getByTestId('block-delete').click();
    await expect(page.locator('.exocortex-editor p', { hasText: 'Ein Block' })).toHaveCount(1);
  });

  /*
   * The handle has to survive the pointer standing still.
   *
   * `DragHandle` re-registers its ProseMirror plugin whenever `onNodeChange`
   * changes identity, and registering hides the handle element again. With an
   * inline callback the handle therefore only existed between two `mousemove`
   * events: it was visible while the mouse travelled and gone the instant it
   * stopped. Hence the wait before the assertion.
   */
  test('keeps the block handle visible while the pointer rests on a block', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type('Ein Block');
    await page.keyboard.press('End');

    const block = page.locator('.exocortex-editor p', { hasText: 'Ein Block' }).first();
    const box = await block.boundingBox();
    if (box === null) throw new Error('block has no layout');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + 8, box.y + box.height / 2, { steps: 8 });

    const handle = page.getByTestId('block-handle');
    await expect(handle).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(handle).toBeVisible();

    // And the actions on it act on the hovered block, not on the cursor's.
    await handle.click();
    await page.getByTestId('block-duplicate').click();
    await expect(page.locator('.exocortex-editor p', { hasText: 'Ein Block' })).toHaveCount(2);
  });

  test('offers the code language picker inside a code block', async ({ page }) => {
    await openEditor(page);

    // The Markdown input rule is the fast path a daily user takes; it fires on the
    // whitespace after the fence, like every other input rule.
    await page.keyboard.type('``` ');
    await expect(page.locator('.exocortex-editor pre')).toHaveCount(1);

    await expect(page.getByTestId('code-block-toolbar')).toBeVisible();
    await page.getByTestId('code-language-trigger').click();
    await page.getByTestId('code-language-typescript').click();

    await page.keyboard.type('const x: number = 1;');
    // Highlighting is derived from the stored language name.
    await expect(page.locator('.exocortex-editor pre .hljs-keyword').first()).toBeVisible();
  });

  test('offers table controls inside a table', async ({ page }) => {
    await openEditor(page);

    await page.keyboard.type('/tabelle');
    await page.getByTestId('slash-option-table').click();
    await expect(page.locator('.exocortex-editor table')).toHaveCount(1);

    const rows = page.locator('.exocortex-editor table tr');
    const cells = page.locator('.exocortex-editor table tr').first().locator('th, td');
    const rowsBefore = await rows.count();
    const columnsBefore = await cells.count();

    await expect(page.getByTestId('table-toolbar')).toBeVisible();
    await page.getByTestId('table-add-row').click();
    await expect(rows).toHaveCount(rowsBefore + 1);
    await page.getByTestId('table-add-column').click();
    await expect(cells).toHaveCount(columnsBefore + 1);

    // A table that can only grow is half a table.
    await page.getByTestId('table-delete-row').click();
    await expect(rows).toHaveCount(rowsBefore);
    await page.getByTestId('table-delete-column').click();
    await expect(cells).toHaveCount(columnsBefore);
  });

  test('inserts a mention through the @ menu', async ({ page }) => {
    await openEditor(page);

    await page.keyboard.type('Termin am @');
    await expect(page.getByTestId('mention-menu')).toBeVisible();
    await page.getByTestId('mention-option-date').first().click();

    await expect(page.locator('.exocortex-editor [data-mention-kind="date"]')).toHaveCount(1);
  });

  test('keeps the toolbar away when nothing is selected', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.type('Kein ausgewählter Text');
    await expect(page.getByTestId('selection-toolbar')).toBeHidden();
  });
});
