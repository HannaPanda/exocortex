import { expect, type Page, test } from '@playwright/test';

import { requireSeedCredentials, waitForCollaboration, workspaceIdFrom } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * Issue #281: room below the line being written in.
 *
 * The page keeps about half a screen of space past its last block while it is
 * written in, so the last line scrolls up to the middle; a click into that
 * space opens the line after the last block (#257); typing on the last line
 * keeps it off the bottom edge, on a phone off the on-screen keyboard; and
 * neither a page that is only read nor a printed one has the space. The
 * numbers behind the margin are unit-tested in `writing-room.test.ts`; what
 * only a browser shows is the layout and ProseMirror's real scrolling.
 */

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
/** What a phone keyboard takes from the bottom of an 844 pixel screen. */
const KEYBOARD = 340;

function longMarkdown(): string {
  const sections: string[] = [];
  for (let index = 1; index <= 30; index += 1) {
    sections.push(`## Abschnitt ${String(index)}`);
    sections.push(`Absatz ${String(index)}: ein Satz, der über eine Zeile hinausreichen darf.`);
  }
  return sections.join('\n\n');
}

async function openLongPage(page: Page): Promise<{ workspaceId: string; documentId: string }> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const workspaceId = workspaceIdFrom(page);
  const created = await page.request.post(`/api/workspaces/${workspaceId}/documents`, {
    data: { title: `Schreibraum ${Date.now().toString(36)}`, type: 'PAGE' },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id: documentId } = (await created.json()) as { id: string };
  const write = await page.request.post(`/api/documents/${documentId}/content`, {
    data: { markdown: `${longMarkdown()}\n`, mode: 'replace' },
  });
  expect(write.ok(), await write.text()).toBe(true);
  await page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
  await waitForCollaboration(page);
  await expect(page.locator('.exocortex-editor p', { hasText: /^Absatz 30:/ })).toBeVisible({
    timeout: 30_000,
  });
  return { workspaceId, documentId };
}

interface Geometry {
  scrollerTop: number;
  scrollerBottom: number;
  visualBottom: number;
  lastBottom: number;
  caretBottom: number | null;
  padding: number;
}

/** Where the scroller, the last block and the caret are, in client pixels. */
function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const browser = globalThis as unknown as {
      document: {
        querySelector: (selector: string) => {
          getBoundingClientRect: () => { top: number; bottom: number };
          lastElementChild: { getBoundingClientRect: () => { bottom: number } } | null;
        } | null;
      };
      getSelection: () => {
        rangeCount: number;
        getRangeAt: (index: number) => {
          getClientRects: () => ArrayLike<{ bottom: number }>;
          startContainer: { parentElement: { getBoundingClientRect: () => { bottom: number } } };
        };
      } | null;
      getComputedStyle: (element: unknown) => { paddingBottom: string };
      visualViewport: { offsetTop: number; height: number } | null;
      innerHeight: number;
    };
    const scroller = browser.document.querySelector('.exocortex-page-scroll');
    const editor = browser.document.querySelector('.exocortex-editor-canvas');
    if (scroller === null || editor === null) throw new Error('no page');
    const last = editor.lastElementChild;
    const selection = browser.getSelection();
    let caretBottom: number | null = null;
    if (selection !== null && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      const rects = range.getClientRects();
      const lastRect = rects.length > 0 ? rects[rects.length - 1] : undefined;
      // A caret in an empty line has no rectangle of its own: its line has.
      caretBottom =
        lastRect === undefined
          ? range.startContainer.parentElement.getBoundingClientRect().bottom
          : lastRect.bottom;
    }
    const viewport = browser.visualViewport;
    return {
      scrollerTop: scroller.getBoundingClientRect().top,
      scrollerBottom: scroller.getBoundingClientRect().bottom,
      visualBottom: viewport === null ? browser.innerHeight : viewport.offsetTop + viewport.height,
      lastBottom: last === null ? 0 : last.getBoundingClientRect().bottom,
      caretBottom,
      padding: Number.parseFloat(browser.getComputedStyle(editor).paddingBottom),
    };
  });
}

/** Scrolls the page so its very end is at the bottom of the scroller. */
async function scrollToEnd(page: Page): Promise<void> {
  await page.locator('.exocortex-page-scroll').evaluate((element) => {
    const scroller = element as unknown as { scrollTop: number; scrollHeight: number };
    scroller.scrollTop = scroller.scrollHeight;
  });
}

/** Scrolls so the last block's bottom edge sits `gap` pixels above `edge`. */
async function placeLastBlockAt(page: Page, edge: number, gap: number): Promise<void> {
  const now = await geometry(page);
  await page.locator('.exocortex-page-scroll').evaluate(
    (element, by) => {
      (element as unknown as { scrollTop: number }).scrollTop += by;
    },
    now.lastBottom - (edge - gap),
  );
}

test.describe('room past the end of the page (issue #281)', () => {
  test.use({ viewport: DESKTOP });

  test('the last line scrolls up to about the middle, and a click there opens a line', async ({
    page,
  }) => {
    await openLongPage(page);
    const surface = page.getByTestId('editor-surface');
    const blocks = await surface.locator(':scope > *').count();

    await scrollToEnd(page);
    const end = await geometry(page);
    const height = end.scrollerBottom - end.scrollerTop;
    // At the end of the page the last block stands in the upper part of the
    // screen, not on its bottom edge.
    expect(end.lastBottom - end.scrollerTop).toBeLessThan(height * 0.6);

    // A click far below it is a click into the line after the last block.
    await page.mouse.click(400, end.scrollerBottom - 60);
    await expect(surface.locator(':scope > *')).toHaveCount(blocks + 1);
    await page.keyboard.type('am Ende weiter');
    await expect(surface.locator(':scope > p').last()).toHaveText('am Ende weiter');
  });

  test('typing on the last line keeps it off the bottom edge', async ({ page }) => {
    await openLongPage(page);
    const last = page.locator('.exocortex-editor p', { hasText: /^Absatz 30:/ });
    await last.click();
    await page.keyboard.press('End');
    const start = await geometry(page);
    // The line being written in sits right on the bottom edge.
    await placeLastBlockAt(page, start.scrollerBottom, 2);

    for (const line of ['eins', 'zwei', 'drei']) {
      await page.keyboard.press('Enter');
      await page.keyboard.type(line);
      const now = await geometry(page);
      expect(now.caretBottom).not.toBeNull();
      expect(now.scrollerBottom - (now.caretBottom ?? 0)).toBeGreaterThan(60);
    }
  });

  test('a page that is only read and a printed page end with their text', async ({ page }) => {
    const { documentId } = await openLongPage(page);
    expect((await geometry(page)).padding).toBeGreaterThan(200);

    await page.emulateMedia({ media: 'print' });
    expect((await geometry(page)).padding).toBeLessThan(60);
    await page.emulateMedia({ media: 'screen' });

    const archived = await page.request.post(`/api/documents/${documentId}/archive`);
    expect(archived.ok(), await archived.text()).toBe(true);
    await page.reload();
    await expect(page.getByTestId('archived-banner')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('editor-surface')).toHaveAttribute('contenteditable', 'false');
    expect((await geometry(page)).padding).toBe(0);
  });
});

test.describe('room past the end of the page on a phone (issue #281)', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('a new line is kept above the on-screen keyboard', async ({ page }) => {
    await openLongPage(page);
    const last = page.locator('.exocortex-editor p', { hasText: /^Absatz 30:/ });
    await last.click();
    await page.keyboard.press('End');

    // The keyboard opens: only the visual viewport shrinks, the layout and
    // the scroll container keep their height, as in Chrome and Safari.
    await page.evaluate((keyboard) => {
      const browser = globalThis as unknown as {
        visualViewport: object;
        innerHeight: number;
      };
      const viewport = browser.visualViewport as {
        dispatchEvent: (event: unknown) => void;
      };
      Object.defineProperty(viewport, 'height', {
        configurable: true,
        get: () => browser.innerHeight - keyboard,
      });
      const { Event } = globalThis as unknown as { Event: new (type: string) => unknown };
      viewport.dispatchEvent(new Event('resize'));
    }, KEYBOARD);
    // The space past the end grows by what the keyboard covers.
    await expect
      .poll(async () => (await geometry(page)).padding)
      .toBeGreaterThan(PHONE.height / 2 - 80 + KEYBOARD - 20);
    const start = await geometry(page);
    expect(start.visualBottom).toBe(PHONE.height - KEYBOARD);
    // The line being written in sits right above the keyboard.
    await placeLastBlockAt(page, start.visualBottom, 2);

    for (const line of ['eins', 'zwei', 'drei']) {
      await page.keyboard.press('Enter');
      await page.keyboard.type(line);
      const now = await geometry(page);
      expect(now.caretBottom).not.toBeNull();
      expect(now.visualBottom - (now.caretBottom ?? 0)).toBeGreaterThan(40);
      expect(now.caretBottom ?? 0).toBeGreaterThan(now.scrollerTop);
    }
  });
});
