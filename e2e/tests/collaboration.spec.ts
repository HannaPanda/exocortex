import { expect, test } from '@playwright/test';

import { loadRepositoryEnv } from '../support/env';
import {
  createPage,
  createSignedInContext,
  requireSeedCredentials,
  waitForCollaboration,
  workspaceIdFrom,
} from '../support/fixtures';

loadRepositoryEnv();

/** The lifetime of a collaboration ticket, as the API issues them. */
const TICKET_TTL_SECONDS = Number(process.env.COLLABORATION_TICKET_TTL_SECONDS ?? '60');

/**
 * The collaboration suite.
 *
 * These are the tests that prove the Yjs/Hocuspocus vertical slice:
 *  * "two browser contexts see each other's edits"     -> live synchronization
 *  * "two browser contexts show live presence"         -> awareness
 *  * "edits survive going offline and reconnecting"    -> y-indexeddb + resync
 *  * "the page tree updates in a second session"       -> application WebSocket
 *  * "an outage longer than the ticket lifetime"       -> ticket renewal
 */
test.beforeAll(() => {
  requireSeedCredentials();
});

test.describe('collaborative editing', () => {
  test('two browser contexts see each other edits', async ({ browser, baseURL }) => {
    const origin = baseURL as string;
    const first = await createSignedInContext(browser, 'johanna', origin);
    const second = await createSignedInContext(browser, 'stefan', origin);

    try {
      const documentId = await createPage(first.page, `Live-Test ${Date.now().toString(36)}`);
      const workspaceId = workspaceIdFrom(first.page);

      await second.page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
      await expect(second.page.getByTestId('editor-surface')).toBeVisible({ timeout: 30_000 });

      const marker = `Von Johanna ${Date.now().toString(36)}`;
      await first.page.getByTestId('editor-surface').click();
      await first.page.keyboard.type(marker);

      // The text must appear in the *other* browser without a reload.
      await expect(second.page.getByTestId('editor-surface')).toContainText(marker, {
        timeout: 30_000,
      });

      const reply = ` und zurück von Stefan`;
      await second.page.getByTestId('editor-surface').click();
      await second.page.keyboard.press('End');
      await second.page.keyboard.type(reply);

      await expect(first.page.getByTestId('editor-surface')).toContainText(reply, {
        timeout: 30_000,
      });
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });

  test('two browser contexts show live presence', async ({ browser, baseURL }) => {
    const origin = baseURL as string;
    const first = await createSignedInContext(browser, 'johanna', origin);
    const second = await createSignedInContext(browser, 'stefan', origin);

    try {
      const documentId = await createPage(first.page, `Presence ${Date.now().toString(36)}`);
      const workspaceId = workspaceIdFrom(first.page);

      await second.page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
      await expect(second.page.getByTestId('editor-surface')).toBeVisible({ timeout: 30_000 });

      // Each side sees two avatars: itself and the other user.
      for (const page of [first.page, second.page]) {
        const avatars = page.getByTestId('presence-avatars');
        await expect(avatars).toBeVisible({ timeout: 30_000 });
        await expect
          .poll(async () => avatars.locator('[data-self]').count(), { timeout: 30_000 })
          .toBeGreaterThanOrEqual(2);
      }

      // A remote caret is rendered once the other user places the cursor.
      await second.page.getByTestId('editor-surface').click();
      await second.page.keyboard.type('Cursor');
      await expect(
        first.page.locator('.exocortex-editor .collaboration-carets__caret').first(),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });

  test('edits survive going offline and reconnecting', async ({ browser, baseURL }) => {
    const origin = baseURL as string;
    const first = await createSignedInContext(browser, 'johanna', origin);
    const second = await createSignedInContext(browser, 'stefan', origin);

    try {
      const documentId = await createPage(first.page, `Offline ${Date.now().toString(36)}`);
      const workspaceId = workspaceIdFrom(first.page);
      await second.page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
      await expect(second.page.getByTestId('editor-surface')).toBeVisible({ timeout: 30_000 });

      await first.page.getByTestId('editor-surface').click();
      await first.page.keyboard.type('online ');
      await expect(second.page.getByTestId('editor-surface')).toContainText('online', {
        timeout: 30_000,
      });

      // Go offline and keep typing: the editor must stay usable.
      await first.context.setOffline(true);
      const offlineMarker = `offline-${Date.now().toString(36)}`;
      await first.page.getByTestId('editor-surface').click();
      await first.page.keyboard.press('End');
      await first.page.keyboard.type(offlineMarker);
      await expect(first.page.getByTestId('editor-surface')).toContainText(offlineMarker);

      // While offline the other session must not see the change.
      await expect(second.page.getByTestId('editor-surface')).not.toContainText(offlineMarker);

      // Back online: the offline edit synchronizes.
      await first.context.setOffline(false);
      await expect(second.page.getByTestId('editor-surface')).toContainText(offlineMarker, {
        timeout: 60_000,
      });
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });

  /**
   * Regression: the ticket used to be fetched once, at mount, and replayed on
   * every reconnect. A single outage longer than the ticket's lifetime therefore
   * poisoned the session for good — every retry was rejected as `expired`, every
   * 32 seconds, until the tab was reloaded.
   *
   * It stayed invisible on a page the browser had opened before, because
   * y-indexeddb still had that one and rendered it from the local copy. A page
   * written from outside and never opened here has nothing to fall back on, so
   * it is the case this test uses.
   */
  test('a page opened during an outage longer than the ticket lifetime still arrives', async ({
    browser,
    baseURL,
  }) => {
    // The outage alone outlasts the default test timeout.
    test.setTimeout((TICKET_TTL_SECONDS + 120) * 1_000);
    const origin = baseURL as string;
    const first = await createSignedInContext(browser, 'johanna', origin);

    try {
      const workspaceId = workspaceIdFrom(first.page);
      const marker = `Von aussen ${Date.now().toString(36)}`;
      // Written entirely through the API, the way an MCP client writes it: this
      // browser has never had the document open and holds no local copy.
      const created = await first.page.request.post(
        `/api/workspaces/${workspaceId}/import/markdown`,
        { data: { markdown: `# Ticket-Erneuerung\n\n${marker}\n`, title: marker } },
      );
      expect(created.ok(), await created.text()).toBe(true);
      const documentId = ((await created.json()) as { document: { id: string } }).document.id;

      // The collaboration socket is unreachable while the page is opened, and
      // stays unreachable for longer than a ticket lives.
      let socketBlocked = true;
      await first.page.routeWebSocket(/\/collab/, async (ws) => {
        if (socketBlocked) {
          await ws.close({ code: 1006 });
          return;
        }
        ws.connectToServer();
      });

      await first.page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
      // Nothing can have arrived: the socket is down and there is no local copy.
      // The editor does not even mount in that state -- it waits for the stored
      // document rather than building itself over an empty one, which is what
      // used to leave a stray paragraph behind on every visit.
      await expect(first.page.getByText('Editor wird verbunden')).toBeVisible({ timeout: 30_000 });
      await expect(first.page.getByTestId('editor-surface')).toHaveCount(0);

      await first.page.waitForTimeout((TICKET_TTL_SECONDS + 15) * 1_000);
      socketBlocked = false;

      // Without a reload, and without any help from the user, the reconnect must
      // carry a ticket the server still accepts.
      await expect(first.page.getByTestId('editor-surface')).toContainText(marker, {
        timeout: 90_000,
      });
      await expect(first.page.getByTestId('connection-status')).toHaveAttribute(
        'data-collaboration',
        'connected',
        { timeout: 30_000 },
      );
    } finally {
      await first.context.close();
    }
  });

  /**
   * Reading a page must not write to it.
   *
   * The editor used to be built as soon as the provider existed, which meant it
   * mounted over a Yjs fragment that was still empty. Tiptap pushed its own
   * initial document into it, Yjs merged that insert with the stored state that
   * arrived a moment later, and the page kept one empty paragraph -- per visit,
   * above or below the text depending on where the client id sorted. Pages that
   * were read often grew visible margins of blank lines over weeks.
   */
  test('reopening a page adds no empty paragraph', async ({ browser, baseURL }) => {
    const origin = baseURL as string;
    const { context, page } = await createSignedInContext(browser, 'johanna', origin);

    try {
      const documentId = await createPage(page, `Leerzeilen ${Date.now().toString(36)}`);
      const workspaceId = workspaceIdFrom(page);
      await page.getByTestId('editor-surface').click();
      await page.keyboard.type('Eine einzige Zeile');

      const blocks = page.locator('[data-testid="editor-surface"] > *');
      await expect(blocks).toHaveCount(1);

      // Three visits, each with its own Yjs client id: the fault added one
      // paragraph per visit, so the count is the whole assertion.
      for (let visit = 0; visit < 3; visit += 1) {
        await page.goto(`/arbeitsbereich/${workspaceId}`);
        await page.goto(`/arbeitsbereich/${workspaceId}/seite/${documentId}`);
        await waitForCollaboration(page);
        await expect(blocks).toHaveCount(1, { timeout: 30_000 });
      }
    } finally {
      await context.close();
    }
  });

  test('the page tree updates in a second session', async ({ browser, baseURL }) => {
    const origin = baseURL as string;
    const first = await createSignedInContext(browser, 'johanna', origin);
    const second = await createSignedInContext(browser, 'stefan', origin);

    try {
      const workspaceId = workspaceIdFrom(first.page);
      await second.page.goto(`/arbeitsbereich/${workspaceId}`);
      await expect(second.page.getByTestId('page-tree')).toBeVisible({ timeout: 30_000 });

      const title = `Realtime ${Date.now().toString(36)}`;
      const documentId = await createPage(first.page, title);

      // The second session learns about the new page through `document.created`.
      await expect(second.page.getByTestId('page-tree')).toContainText(title, { timeout: 30_000 });

      // Archiving is reflected in both sessions.
      await first.page.getByTestId('document-actions').click();
      await first.page.getByTestId('archive-document').click();
      await expect(second.page.getByTestId('page-tree')).not.toContainText(title, {
        timeout: 30_000,
      });

      await second.page.getByTestId('toggle-trash').click();
      await expect(second.page.getByTestId('trash-sheet')).toContainText(title, {
        timeout: 30_000,
      });
      expect(documentId).toMatch(/^[a-z0-9]+$/);
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });
});
