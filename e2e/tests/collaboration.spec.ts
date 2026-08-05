import { expect, test } from '@playwright/test';

import {
  createPage,
  createSignedInContext,
  requireSeedCredentials,
  workspaceIdFrom,
} from '../support/fixtures';

/**
 * The collaboration suite.
 *
 * These are the tests that prove the Yjs/Hocuspocus vertical slice:
 *  * "two browser contexts see each other's edits"     -> live synchronization
 *  * "two browser contexts show live presence"         -> awareness
 *  * "edits survive going offline and reconnecting"    -> y-indexeddb + resync
 *  * "the page tree updates in a second session"       -> application WebSocket
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
      await expect(second.page.getByTestId('trash-list')).toContainText(title, { timeout: 30_000 });
      expect(documentId).toMatch(/^[a-z0-9]+$/);
    } finally {
      await first.context.close();
      await second.context.close();
    }
  });
});
