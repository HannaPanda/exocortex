import { expect, type Page, test, type WebSocketRoute } from '@playwright/test';

import { requireSeedCredentials, waitForCollaboration, workspaceIdFrom } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * Issue #285: the view jumped to the top of the page.
 *
 * After unlocking a phone the collaboration socket was dead, and showing the
 * tab again "revived" the connection by building a new document, a new
 * provider and therefore a new editor; the editor unmounted for the spinner
 * and came back at the top. A failed refetch of the page's details swapped
 * the whole page for the error panel, with the same result. Both are measured
 * here at phone width, where Stefan saw it.
 */

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(() => {
  requireSeedCredentials();
});

const PHONE = { width: 390, height: 844 };

/** How long the page's details stay fresh in the query cache (`providers.tsx`). */
const DETAILS_STALE_MS = 15_000;

/** A page long enough that "the top" and "where I was" are far apart. */
function longMarkdown(): string {
  const sections: string[] = [];
  for (let index = 1; index <= 40; index += 1) {
    sections.push(`## Abschnitt ${String(index)}`);
    sections.push(
      `Absatz ${String(index)}: ein Satz, der lang genug ist, um auf einem Telefon über mehrere Zeilen zu laufen.`,
    );
  }
  return sections.join('\n\n');
}

/** Creates the long page through the API; nothing is opened yet. */
async function createLongPage(page: Page): Promise<{ workspaceId: string; documentId: string }> {
  await page.goto('/arbeitsbereich');
  await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });
  const workspaceId = workspaceIdFrom(page);
  const created = await page.request.post(`/api/workspaces/${workspaceId}/documents`, {
    data: { title: `Lesestelle ${Date.now().toString(36)}`, type: 'PAGE' },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const { id: documentId } = (await created.json()) as { id: string };
  const write = await page.request.post(`/api/documents/${documentId}/content`, {
    data: { markdown: `${longMarkdown()}\n`, mode: 'replace' },
  });
  expect(write.ok(), await write.text()).toBe(true);
  return { workspaceId, documentId };
}

const scrollTop = (page: Page): Promise<number> =>
  page
    .locator('.exocortex-page-scroll')
    .evaluate((scroller) => (scroller as unknown as { scrollTop: number }).scrollTop);

/**
 * Tags the editor's DOM node, so a later look can tell the same editor from a
 * new one that merely looks the same.
 */
async function tagEditor(page: Page): Promise<void> {
  await page.getByTestId('editor-surface').evaluate((element) => {
    (element as unknown as { dataset: Record<string, string> }).dataset.probe = 'kept';
  });
}

/** Scrolls to the middle of the page and puts the caret there. */
async function readInTheMiddle(page: Page): Promise<number> {
  const target = page.locator('.exocortex-editor p', { hasText: /^Absatz 25:/ });
  await target.scrollIntoViewIfNeeded();
  await target.click();
  const position = await scrollTop(page);
  expect(position).toBeGreaterThan(1000);
  return position;
}

/** The same editor, at the same place. */
async function expectUnmoved(page: Page, before: number): Promise<void> {
  await expect(page.getByTestId('editor-surface')).toHaveAttribute('data-probe', 'kept');
  expect(Math.abs((await scrollTop(page)) - before)).toBeLessThan(4);
}

test.describe('the reading position (issue #285)', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test('showing the tab after the socket died keeps the editor, the place and the caret', async ({
    page,
  }) => {
    const { workspaceId, documentId } = await createLongPage(page);
    // Every collaboration socket goes through here, so the test can kill the
    // open one and refuse the next attempts, the way a sleeping phone does.
    const sockets: WebSocketRoute[] = [];
    let refused = false;
    await page.routeWebSocket(/\/collab/, (ws) => {
      if (refused) {
        void ws.close({ code: 1006 });
        return;
      }
      ws.connectToServer();
      sockets.push(ws);
    });
    await page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
    await waitForCollaboration(page);
    const before = await readInTheMiddle(page);
    await tagEditor(page);

    refused = true;
    for (const ws of sockets) await ws.close({ code: 1006 });
    await expect(page.getByTestId('connection-status')).not.toHaveAttribute(
      'data-collaboration',
      'connected',
    );
    // The provider waits a second before it tries again; showing the tab in
    // that gap is what used to rebuild everything.
    await page.waitForTimeout(1_500);
    await page.evaluate(() => {
      const browser = globalThis as unknown as {
        document: { dispatchEvent: (event: unknown) => void };
        Event: new (type: string) => unknown;
      };
      browser.document.dispatchEvent(new browser.Event('visibilitychange'));
    });
    refused = false;
    await waitForCollaboration(page);

    await expectUnmoved(page, before);
    // The caret is still where it was: typing lands in paragraph 25.
    const marker = ` wieder da ${Date.now().toString(36)}`;
    await page.keyboard.type(marker);
    await expect(page.locator('.exocortex-editor p', { hasText: /^Absatz 25:/ })).toContainText(
      marker,
    );
  });

  test('a failed refetch of the page keeps the page on screen', async ({ page }) => {
    const { workspaceId, documentId } = await createLongPage(page);
    await page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
    await waitForCollaboration(page);
    const before = await readInTheMiddle(page);
    await tagEditor(page);

    // The API is away (a deploy restarting it), and the details, stale by
    // now, are fetched again because the network came back.
    await page.waitForTimeout(DETAILS_STALE_MS + 1_000);
    await page.route(`**/api/documents/${documentId}`, (route) =>
      route.fulfill({ status: 502, contentType: 'text/plain', body: 'bad gateway' }),
    );
    const refetched = page.waitForResponse((response) =>
      response.url().endsWith(`/api/documents/${documentId}`),
    );
    await page.evaluate(() => {
      const browser = globalThis as unknown as {
        dispatchEvent: (event: unknown) => void;
        Event: new (type: string) => unknown;
      };
      browser.dispatchEvent(new browser.Event('offline'));
      browser.dispatchEvent(new browser.Event('online'));
    });
    await refetched;
    // Past the query's two retries, which is when the error panel appeared.
    await page.waitForTimeout(6_000);

    await expectUnmoved(page, before);
  });
});
