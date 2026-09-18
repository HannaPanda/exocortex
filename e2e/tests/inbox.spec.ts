import { type APIRequestContext, expect, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * Quick capture and the inbox (issue #71, ADR-036).
 *
 * The browser half is the feature: capture is measured in keystrokes, and a
 * shortcut that stops working is a feature nobody notices losing until they
 * have gone back to writing things on paper. The API half proves the claim the
 * whole design rests on -- that a capture is an ordinary page under an ordinary
 * page -- against a workspace that starts without an inbox, which is the one
 * state the shipped deployment can no longer be put back into.
 */

test.describe('quick capture in the browser', () => {
  test.use({ storageState: storageStatePath('johanna') });

  test.beforeAll(() => {
    requireSeedCredentials();
  });

  test('captures with the keyboard and offers to file the result', async ({ page }) => {
    const marker = `Erfasst-${Date.now().toString(36)}`;

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[a-z0-9]+/, { timeout: 60_000 });

    await page.keyboard.press('Control+e');
    await expect(page.getByTestId('capture-dialog')).toBeVisible();

    await page.getByTestId('capture-text').fill(`${marker}\n\nDer Rest der Notiz.`);
    await page.keyboard.press('Control+Enter');

    // The confirmation, not the dialog closing: capture stays open for the next
    // thought, which is the behaviour worth pinning down.
    const open = page.getByTestId('capture-open');
    await expect(open).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('capture-text')).toHaveValue('');

    await open.click();
    await expect(page.getByTestId('document-title')).toHaveValue(marker, { timeout: 30_000 });

    // The page knows it is sitting in the inbox, which is what turns filing
    // from a context menu somewhere in the tree into one button.
    const file = page.getByTestId('file-from-inbox');
    await expect(file).toBeVisible();
    await file.click();
    await expect(page.getByText('Passenden Ort vorschlagen')).toBeVisible();
  });
});

test.describe('capture over the API', () => {
  let api: APIRequestContext;
  let origin: string;
  let workspaceId: string;

  test.beforeAll(async ({ playwright, baseURL }) => {
    requireSeedCredentials();
    origin = baseURL as string;
    api = await playwright.request.newContext({ httpCredentials: BASIC_AUTH_CREDENTIALS });
    await apiSignIn(api, 'johanna', origin);

    const created = await api.post(`${origin}/api/workspaces`, {
      data: { name: `Eingang ${Date.now().toString(36)}` },
    });
    expect(created.ok(), await created.text()).toBe(true);
    workspaceId = ((await created.json()) as { id: string }).id;
    recordWorkspace(workspaceId);
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test('creates the inbox on the first capture and lists what is waiting', async () => {
    const empty = await api.get(`${origin}/api/workspaces/${workspaceId}/inbox`);
    expect(empty.ok(), await empty.text()).toBe(true);
    expect(await empty.json()).toMatchObject({ inbox: null, items: [], itemCount: 0 });

    const first = await api.post(`${origin}/api/workspaces/${workspaceId}/capture`, {
      data: { text: 'Erste Notiz\n\nMit einem zweiten Absatz.' },
    });
    expect(first.status(), await first.text()).toBe(201);
    const firstBody = (await first.json()) as {
      document: { id: string; title: string; parentId: string | null };
      parent: { id: string; title: string } | null;
      inboxCreated: boolean;
    };
    expect(firstBody.inboxCreated).toBe(true);
    expect(firstBody.document.title).toBe('Erste Notiz');
    expect(firstBody.document.parentId).toBe(firstBody.parent?.id);

    // The second capture finds the inbox instead of making a second one.
    const second = await api.post(`${origin}/api/workspaces/${workspaceId}/capture`, {
      data: { text: 'https://example.com/artikel', sourceUrl: 'https://example.com/artikel' },
    });
    expect(second.status(), await second.text()).toBe(201);
    const secondBody = (await second.json()) as {
      document: { id: string; title: string };
      parent: { id: string } | null;
      inboxCreated: boolean;
    };
    expect(secondBody.inboxCreated).toBe(false);
    expect(secondBody.parent?.id).toBe(firstBody.parent?.id);
    expect(secondBody.document.title).toBe('example.com/artikel');

    const inbox = await api.get(`${origin}/api/workspaces/${workspaceId}/inbox`);
    expect(inbox.ok(), await inbox.text()).toBe(true);
    const listed = (await inbox.json()) as {
      inbox: { id: string } | null;
      items: { id: string }[];
      itemCount: number;
    };
    expect(listed.inbox?.id).toBe(firstBody.parent?.id);
    expect(listed.itemCount).toBe(2);
    // Newest first: the inbox is read to be emptied.
    expect(listed.items.map((item) => item.id)).toEqual([
      secondBody.document.id,
      firstBody.document.id,
    ]);

    // A captured page is an ordinary page: it moves with the ordinary route.
    const moved = await api.post(`${origin}/api/documents/${secondBody.document.id}/move`, {
      data: { parentId: null },
    });
    expect(moved.ok(), await moved.text()).toBe(true);

    const afterMove = await api.get(`${origin}/api/workspaces/${workspaceId}/inbox`);
    expect(((await afterMove.json()) as { itemCount: number }).itemCount).toBe(1);
  });
});
