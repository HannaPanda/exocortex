import { expect, type Page, test } from '@playwright/test';

import { requireSeedCredentials, waitForCollaboration, workspaceIdFrom } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

const SECTIONS = ['Einleitung', 'Architektur', 'Datenmodell', 'Betrieb', 'Sicherheit', 'Ausblick'];

/** A page long enough for the outline: six sections, each with a subsection. */
function longMarkdown(marker: string): string {
  const paragraph =
    'Ein Absatz, der lang genug ist, um eine Zeile zu füllen und die Seite in die Länge ' +
    'zu ziehen, damit die Gliederung etwas zu tun bekommt. ';
  return SECTIONS.map(
    (section) =>
      `## ${section} ${marker}\n\n${paragraph.repeat(6)}\n\n${paragraph.repeat(5)}\n\n` +
      `### Details zu ${section}\n\n${paragraph.repeat(6)}\n\n${paragraph.repeat(4)}\n`,
  ).join('\n');
}

async function importPage(page: Page, title: string, markdown: string): Promise<string> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const workspaceId = workspaceIdFrom(page);
  const response = await page.request.post(`/api/workspaces/${workspaceId}/import/markdown`, {
    data: { markdown, title },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const id = ((await response.json()) as { document: { id: string } }).document.id;
  await page.goto(`/arbeitsbereich/${workspaceId}/seite/${id}`);
  await expect(page.getByTestId('editor-surface')).toBeVisible();
  await waitForCollaboration(page);
  return id;
}

async function exportMarkdown(page: Page, id: string): Promise<string> {
  const response = await page.request.get(`/api/documents/${id}/export/markdown`);
  return ((await response.json()) as { markdown: string }).markdown;
}

/** A 1x1 PNG: a cover only has to exist for the layout to make room for it. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/** The cover's menu, every control of it. */
const COVER_CONTROLS = ['reposition-cover', 'replace-cover', 'generate-cover', 'remove-cover'];

async function setCover(page: Page, id: string): Promise<void> {
  const upload = await page.request.post(`/api/workspaces/${workspaceIdFrom(page)}/attachments`, {
    multipart: { file: { name: 'titelbild.png', mimeType: 'image/png', buffer: PIXEL_PNG } },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const attachmentId = ((await upload.json()) as { attachment: { id: string } }).attachment.id;
  const cover = await page.request.patch(`/api/documents/${id}`, {
    data: { coverAttachmentId: attachmentId },
  });
  expect(cover.ok(), await cover.text()).toBe(true);
}

/** Distance of a heading from the top of the page's scroll container. */
async function headingOffset(page: Page, text: string): Promise<number> {
  const heading = await page.locator('.ProseMirror :is(h2, h3)', { hasText: text }).boundingBox();
  const scroller = await page.locator('.exocortex-page-scroll').boundingBox();
  if (heading === null || scroller === null) throw new Error(`"${text}" is not laid out`);
  return heading.y - scroller.y;
}

/**
 * The floating outline of a long page (issue #194). The rules underneath
 * (which headings a collapsed section hides, where the reading line sits,
 * which strokes the scale keeps) are unit tests in `packages/editor` and
 * `outline-geometry.test.ts`; this proves the loop in a real page.
 */
test.describe('page outline', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // Since 1304e7c1 one heading is enough for an outline; a page without any
  // has nothing to list.
  test('leaves a page without headings alone', async ({ page }) => {
    await importPage(page, `Kurz ${Date.now().toString(36)}`, 'Ein Absatz.\n\nUnd noch einer.\n');
    await expect(page.locator('.ProseMirror p').first()).toBeVisible();
    await expect(page.getByTestId('page-outline-rail')).toHaveCount(0);
    await expect(page.getByTestId('page-outline-compact')).toHaveCount(0);
  });

  test('opens, jumps without editing, and follows the reader', async ({ page }) => {
    const marker = Date.now().toString(36);
    const id = await importPage(page, `Gliederung ${marker}`, longMarkdown(marker));
    const before = await exportMarkdown(page, id);

    const rail = page.getByTestId('page-outline-rail');
    await expect(rail).toBeVisible();

    // Keyboard: the trigger opens with Enter, Escape closes and hands focus back.
    await rail.focus();
    await page.keyboard.press('Enter');
    const popover = page.getByTestId('page-outline-popover');
    await expect(popover).toBeVisible();
    const entries = popover.getByTestId('page-outline-entry');
    await expect(entries).toHaveCount(SECTIONS.length * 2);
    await expect(entries.nth(0)).toContainText(`Einleitung ${marker}`);
    await expect(entries.nth(0)).toHaveAttribute('data-depth', '0');
    await expect(entries.nth(1)).toHaveAttribute('data-depth', '1');
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(rail).toBeFocused();

    // A jump puts the heading just below the top of the visible page.
    await rail.click();
    await popover.getByRole('button', { name: `Sicherheit ${marker}` }).click();
    await expect(popover).toBeHidden();
    await expect.poll(() => headingOffset(page, `Sicherheit ${marker}`)).toBeLessThan(60);
    await expect.poll(() => headingOffset(page, `Sicherheit ${marker}`)).toBeGreaterThan(0);

    await rail.click();
    await expect(popover.locator('[aria-current="location"]')).toContainText(
      `Sicherheit ${marker}`,
    );
    await page.keyboard.press('Escape');

    // Scrolling by hand moves the current section along.
    // Upwards, with the wheel over the text, the way a reader would.
    await page.locator('.ProseMirror').hover();
    await page.mouse.wheel(0, (await headingOffset(page, `Datenmodell ${marker}`)) - 40);
    await expect.poll(() => headingOffset(page, `Datenmodell ${marker}`)).toBeLessThan(80);
    await rail.click();
    await expect(popover.locator('[aria-current="location"]')).toContainText(
      `Datenmodell ${marker}`,
    );
    await page.keyboard.press('Escape');

    // Navigating changed nothing in the document.
    expect(await exportMarkdown(page, id)).toBe(before);
  });

  test('follows a heading written from outside the editor', async ({ page }) => {
    const marker = Date.now().toString(36);
    const id = await importPage(page, `Live ${marker}`, longMarkdown(marker));
    await expect(page.getByTestId('page-outline-rail')).toBeVisible();

    const write = await page.request.post(`/api/documents/${id}/content`, {
      data: { markdown: `## Nachtrag ${marker}\n\nVon außen geschrieben.\n`, mode: 'append' },
    });
    expect(write.ok(), await write.text()).toBe(true);
    await expect(page.locator('.ProseMirror h2', { hasText: `Nachtrag ${marker}` })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByTestId('page-outline-rail').click();
    const entries = page.getByTestId('page-outline-popover').getByTestId('page-outline-entry');
    await expect(entries.last()).toContainText(`Nachtrag ${marker}`);
  });

  test('lists a collapsed section once and does not unfold it', async ({ page }) => {
    const marker = Date.now().toString(36);
    await importPage(page, `Eingeklappt ${marker}`, longMarkdown(marker));
    const heading = page.locator('.ProseMirror h2', { hasText: `Architektur ${marker}` });
    await heading.hover();
    await heading.getByTestId('heading-toggle').click();
    await expect(
      page.locator('.ProseMirror h3', { hasText: 'Details zu Architektur' }),
    ).toBeHidden();

    await page.getByTestId('page-outline-rail').click();
    const popover = page.getByTestId('page-outline-popover');
    await expect(popover.getByTestId('page-outline-entry')).toHaveCount(SECTIONS.length * 2 - 1);
    await expect(popover.getByText('Details zu Architektur')).toHaveCount(0);
    await popover.getByRole('button', { name: new RegExp(`Architektur ${marker}`) }).click();
    await expect.poll(() => headingOffset(page, `Architektur ${marker}`)).toBeLessThan(60);
    await expect(
      page.locator('.ProseMirror h3', { hasText: 'Details zu Architektur' }),
    ).toBeHidden();
  });

  test('can be pinned beside the page where there is room', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    const marker = Date.now().toString(36);
    await importPage(page, `Angepinnt ${marker}`, longMarkdown(marker));
    await page.getByTestId('page-outline-rail').click();
    await page.getByTestId('page-outline-pin').click();
    const pinned = page.getByTestId('page-outline-pinned');
    await expect(pinned).toBeVisible();

    // It sits beside the text, never over it.
    const text = await page.locator('.ProseMirror').boundingBox();
    const box = await pinned.boundingBox();
    expect(box !== null && text !== null && box.x >= text.x + text.width).toBe(true);

    await page.reload();
    await expect(page.getByTestId('page-outline-pinned')).toBeVisible();
    await page.getByTestId('page-outline-pin').click();
    await expect(page.getByTestId('page-outline-rail')).toBeVisible();
  });

  // Issue #266: the outline floats beside the scroll container, so at the top
  // of the page it used to lie over the cover and over the cover's menu. It
  // starts where the page's content starts and rises with it to the top edge.
  test('starts below the cover and the title in every page width', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    const marker = Date.now().toString(36);
    const id = await importPage(page, `Titelbild ${marker}`, longMarkdown(marker));
    await setCover(page, id);
    await page.reload();
    await page.getByTestId('page-outline-rail').click();
    await page.getByTestId('page-outline-pin').click();
    await expect(page.getByTestId('page-outline-pinned')).toBeVisible();

    // Pinned in every page width since issue #267.
    const outline = page.getByTestId('page-outline-pinned');
    for (const layout of ['narrow', 'wide', 'full'] as const) {
      const changed = await page.request.patch(`/api/documents/${id}`, { data: { layout } });
      expect(changed.ok(), await changed.text()).toBe(true);
      await page.reload();
      await expect(page.getByTestId('page-cover-image')).toBeVisible();
      await expect(outline).toBeVisible();

      const title = await page.getByTestId('document-title').boundingBox();
      const top = async (): Promise<number> => (await outline.boundingBox())?.y ?? -1;
      expect(title).not.toBeNull();
      await expect
        .poll(top, { message: layout })
        .toBeGreaterThanOrEqual((title?.y ?? 0) + (title?.height ?? 0));
      // The menu is reachable: a trial click fails when anything lies on it.
      await page.getByTestId('page-cover').hover();
      for (const control of COVER_CONTROLS) {
        await page.getByTestId(control).click({ trial: true, timeout: 5_000 });
      }

      // Scrolled into the text, it stays in view at the top edge as before.
      await page.locator('.ProseMirror').hover();
      await page.mouse.wheel(0, 1500);
      const scroller = await page.locator('.exocortex-page-scroll').boundingBox();
      await expect
        .poll(async () => (await top()) - (scroller?.y ?? 0), { message: layout })
        .toBeLessThan(40);
      await expect(outline).toBeInViewport();
    }
  });
});

// Issue #267: the pin depended on the margin the text left, which a wide or
// full-width page in an ordinary window never leaves. Pinned, the list takes
// a column of its own in every page width; the text moves aside, never under.
test.describe('page outline pinned in every page width', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const layout of ['narrow', 'wide', 'full'] as const) {
    test(`can be pinned at page width ${layout} without covering the text`, async ({ page }) => {
      const marker = Date.now().toString(36);
      const id = await importPage(page, `Spalte ${layout} ${marker}`, longMarkdown(marker));
      const changed = await page.request.patch(`/api/documents/${id}`, { data: { layout } });
      expect(changed.ok(), await changed.text()).toBe(true);
      await setCover(page, id);
      await page.reload();
      await expect(page.getByTestId('editor-surface')).toBeVisible();

      await page.getByTestId('page-outline-rail').click();
      await expect(page.getByTestId('page-outline-pin-note')).toHaveCount(0);
      await page.getByTestId('page-outline-pin').click();
      const pinned = page.getByTestId('page-outline-pinned');
      await expect(pinned).toBeVisible();

      // Beside the text with air between, at the top and scrolled into it.
      const besideText = async (): Promise<number> => {
        const text = await page.locator('.ProseMirror').boundingBox();
        const box = await pinned.boundingBox();
        if (text === null || box === null) return -1;
        return box.x - (text.x + text.width);
      };
      await expect.poll(besideText, { message: layout }).toBeGreaterThanOrEqual(16);
      await page.locator('.ProseMirror').hover();
      await page.mouse.wheel(0, 1500);
      await expect.poll(besideText, { message: layout }).toBeGreaterThanOrEqual(16);
      await expect(pinned).toBeInViewport();

      // The cover still spans the whole page area, the column included.
      // (Less a scrollbar at most; without the bleed it would end 16rem short.)
      await page.mouse.wheel(0, -3000);
      const cover = await page.getByTestId('page-cover').boundingBox();
      const area = await page.locator('.exocortex-page-scroll').boundingBox();
      expect(cover !== null && area !== null).toBe(true);
      expect((cover?.width ?? 0) + 20).toBeGreaterThan(area?.width ?? 0);

      // Unpinned, the column is given back to the page.
      await page.getByTestId('page-outline-pin').click();
      await expect(page.getByTestId('page-outline-rail')).toBeVisible();
      await expect(pinned).toHaveCount(0);
    });
  }

  test('says why it cannot be pinned in a window too narrow for the column', async ({ page }) => {
    const marker = Date.now().toString(36);
    await importPage(page, `Zu schmal ${marker}`, longMarkdown(marker));
    await page.getByTestId('page-outline-rail').click();
    await page.getByTestId('page-outline-pin').click();
    await expect(page.getByTestId('page-outline-pinned')).toBeVisible();

    // A window narrower than the column plus a readable measure.
    await page.setViewportSize({ width: 600, height: 900 });
    await expect(page.getByTestId('page-outline-pinned')).toHaveCount(0);
    const trigger = page
      .getByTestId('page-outline-rail')
      .or(page.getByTestId('page-outline-compact'));
    await trigger.click();
    const popover = page.getByTestId('page-outline-popover');
    await expect(popover.getByTestId('page-outline-pin-note')).toBeVisible();
    await expect(popover.getByTestId('page-outline-pin')).toHaveCount(0);

    // The choice is kept: back in a wide window the list is pinned again.
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByTestId('page-outline-pinned')).toBeVisible();
    await page.getByTestId('page-outline-pin').click();
  });
});

// Issue #283: a reader may choose that the pinned list lies over the text
// instead of the text moving aside, and that it lets the covered text
// through. A preference on the account, so it is set back after every test.
test.describe('page outline laid over the text', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.afterEach(async ({ request, baseURL }) => {
    await request.patch('/api/me/preferences', {
      data: { outlinePinned: 'column', outlineTransparency: 'none' },
      headers: { origin: baseURL as string },
    });
  });

  test('is chosen in the settings and leaves the text where it is', async ({ page }) => {
    await page.goto('/einstellungen/editor');
    await page.getByTestId('outline-pinned').click();
    await page.getByRole('option', { name: 'Über dem Text liegen' }).click();
    await expect(page.getByTestId('outline-transparency')).toBeEnabled();
    await page.getByTestId('outline-transparency').click();
    await page.getByRole('option', { name: 'Stark durchscheinend' }).click();
    await expect
      .poll(async () => (await page.request.get('/api/me/preferences')).json())
      .toMatchObject({ outlinePinned: 'overlay', outlineTransparency: 'strong' });

    const marker = Date.now().toString(36);
    const id = await importPage(page, `Darüber ${marker}`, longMarkdown(marker));
    const changed = await page.request.patch(`/api/documents/${id}`, { data: { layout: 'full' } });
    expect(changed.ok(), await changed.text()).toBe(true);
    await page.reload();
    await expect(page.getByTestId('editor-surface')).toBeVisible();
    const textBefore = await page.locator('.ProseMirror').boundingBox();

    await page.getByTestId('page-outline-rail').click();
    await page.getByTestId('page-outline-pin').click();
    const pinned = page.getByTestId('page-outline-pinned');
    await expect(pinned).toBeVisible();
    await expect(pinned).toHaveAttribute('data-mode', 'overlay');
    await expect(pinned).toHaveAttribute('data-covering', 'true');

    // The text did not move, and the list lies on it.
    const textAfter = await page.locator('.ProseMirror').boundingBox();
    expect(textAfter?.width).toBe(textBefore?.width);
    expect(textAfter?.x).toBe(textBefore?.x);
    const box = await pinned.boundingBox();
    expect(box !== null && textAfter !== null && box.x < textAfter.x + textAfter.width).toBe(true);

    // Let through at rest, whole under the pointer and with the keyboard in it.
    await page.locator('.exocortex-page-title').hover();
    await expect(pinned).toHaveCSS('opacity', '0.6');
    await pinned.hover();
    await expect(pinned).toHaveCSS('opacity', '1');
    await page.locator('.exocortex-page-title').hover();
    await expect(pinned).toHaveCSS('opacity', '0.6');
    await page.getByTestId('page-outline-pin').focus();
    await page.keyboard.press('Tab');
    await expect(pinned.getByTestId('page-outline-entry').first()).toBeFocused();
    await expect(pinned).toHaveCSS('opacity', '1');
    // No trap: the keyboard leaves the list the way it came in.
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('page-outline-pin')).toBeFocused();

    // Unpinned, the scale is back and nothing was taken from the page.
    await page.getByTestId('page-outline-pin').click();
    await expect(page.getByTestId('page-outline-rail')).toBeVisible();
  });

  test('stays flat where the margin holds it', async ({ page, request, baseURL }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await request.patch('/api/me/preferences', {
      data: { outlinePinned: 'overlay', outlineTransparency: 'strong' },
      headers: { origin: baseURL as string },
    });
    const marker = Date.now().toString(36);
    await importPage(page, `Rand ${marker}`, longMarkdown(marker));
    await page.getByTestId('page-outline-rail').click();
    await page.getByTestId('page-outline-pin').click();
    const pinned = page.getByTestId('page-outline-pinned');
    await expect(pinned).toBeVisible();
    await expect(pinned).not.toHaveAttribute('data-covering', 'true');
    await expect(pinned).toHaveCSS('opacity', '1');
    const text = await page.locator('.ProseMirror').boundingBox();
    const box = await pinned.boundingBox();
    expect(box !== null && text !== null && box.x >= text.x + text.width).toBe(true);
    await page.getByTestId('page-outline-pin').click();
  });
});

// Issue #283, second part: a list laid over the text steps aside for the
// line the caret is on, unless the reader switched that off.
test.describe('page outline stepping aside for the caret', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.afterEach(async ({ request, baseURL }) => {
    await request.patch('/api/me/preferences', {
      data: { outlinePinned: 'column', outlineTransparency: 'none', outlineDodge: true },
      headers: { origin: baseURL as string },
    });
  });

  test('moves off the line being written on, and stays when asked to', async ({
    page,
    request,
    baseURL,
  }) => {
    await request.patch('/api/me/preferences', {
      data: { outlinePinned: 'overlay', outlineDodge: true },
      headers: { origin: baseURL as string },
    });
    const marker = Date.now().toString(36);
    const id = await importPage(page, `Ausweichen ${marker}`, longMarkdown(marker));
    const changed = await page.request.patch(`/api/documents/${id}`, { data: { layout: 'full' } });
    expect(changed.ok(), await changed.text()).toBe(true);
    await page.reload();
    await expect(page.getByTestId('editor-surface')).toBeVisible();
    await page.getByTestId('page-outline-rail').click();
    await page.getByTestId('page-outline-pin').click();
    const pinned = page.getByTestId('page-outline-pinned');
    await expect(pinned).toHaveAttribute('data-covering', 'true');

    // A line in the middle of the list, clicked left of it, where it is free.
    const before = await pinned.boundingBox();
    const text = await page.locator('.ProseMirror').boundingBox();
    if (before === null || text === null) throw new Error('not laid out');
    const lineY = before.y + Math.min(80, before.height / 2);
    await page.mouse.click(text.x + 40, lineY);
    await expect(pinned).toHaveAttribute('data-dodging', 'true');
    const clear = async (): Promise<boolean> => {
      const box = await pinned.boundingBox();
      return box !== null && (box.y > lineY + 4 || box.y + box.height < lineY - 4);
    };
    await expect.poll(clear).toBe(true);

    // Typing on keeps it off the line.
    await page.keyboard.type(' weiter');
    await expect.poll(clear).toBe(true);

    // Under the pointer it stays where it is, even when the editor lets go.
    await pinned.hover();
    const held = await pinned.boundingBox();
    await page.locator('.exocortex-page-title').evaluate((title) => {
      (title.ownerDocument.activeElement as { blur?: () => void } | null)?.blur?.();
    });
    expect((await pinned.boundingBox())?.y).toBe(held?.y);

    // Leaving the editor and the list, it goes back to its place.
    await page.mouse.move(text.x + 10, text.y + 10);
    await expect(pinned).not.toHaveAttribute('data-dodging', 'true');

    // Switched off, the caret may sit under it.
    await request.patch('/api/me/preferences', {
      data: { outlineDodge: false },
      headers: { origin: baseURL as string },
    });
    await page.reload();
    await expect(pinned).toHaveAttribute('data-covering', 'true');
    const still = await pinned.boundingBox();
    if (still === null) throw new Error('not laid out');
    await page.mouse.click(text.x + 40, still.y + Math.min(80, still.height / 2));
    await page.keyboard.type(' x');
    await expect(pinned).not.toHaveAttribute('data-dodging', 'true');
    expect((await pinned.boundingBox())?.y).toBe(still.y);
    await page.getByTestId('page-outline-pin').click();
  });
});

test.describe('page outline on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('is a compact button whose list stays on screen', async ({ page }) => {
    const marker = Date.now().toString(36);
    await importPage(page, `Telefon ${marker}`, longMarkdown(marker));
    const button = page.getByTestId('page-outline-compact');
    await expect(button).toBeVisible();
    await button.tap();
    const popover = page.getByTestId('page-outline-popover');
    await expect(popover).toBeVisible();
    const box = await popover.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    await popover.getByRole('button', { name: `Betrieb ${marker}` }).tap();
    await expect.poll(() => headingOffset(page, `Betrieb ${marker}`)).toBeLessThan(60);
  });

  // Issue #266, on a phone: the outline is a button at the bottom edge, so the
  // cover's menu has to be reachable on its own, every control on screen.
  test('leaves the cover menu on screen and reachable', async ({ page }) => {
    const marker = Date.now().toString(36);
    const id = await importPage(page, `Telefon Titelbild ${marker}`, longMarkdown(marker));
    await setCover(page, id);
    await page.reload();
    await expect(page.getByTestId('page-cover-image')).toBeVisible();
    await expect(page.getByTestId('page-outline-compact')).toBeVisible();
    for (const control of COVER_CONTROLS) {
      const box = await page.getByTestId(control).boundingBox();
      expect(box !== null && box.x >= 0 && box.x + box.width <= 390, control).toBe(true);
      await page.getByTestId(control).click({ trial: true, timeout: 5_000 });
    }
  });
});
