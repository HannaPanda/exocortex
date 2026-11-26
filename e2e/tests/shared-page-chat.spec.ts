import { type APIRequestContext, expect, test } from '@playwright/test';

import { AI_TEST_TIMEOUT_MS, waitForAiRun } from '../support/ai-run';
import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials, SEED_USERS } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * The KI chat on a page somebody shared with the reader (issue #234, ADR-092).
 *
 * Johanna's test account shares a page of a fresh workspace with Stefan's,
 * which is no member there. Stefan opens it under `/geteilt/<id>` and asks the
 * chat about it: the panel has to say which of his own workspaces carries the
 * conversation, the run has to answer, and the conversation has to land in his
 * workspace rather than in the page's. What the run may do on the page is
 * proved against the database in `shared-page-chat.integration.test.ts`; this
 * is the part only a browser shows, plus one real run.
 */
test.use({ storageState: storageStatePath('stefan') });

let johannaApi: APIRequestContext;
let origin: string;
let sharerWorkspaceId: string;
let documentId: string;
let shareId: string;
const marker = `Pfauenfeder${Date.now().toString(36)}`;

test.beforeAll(async ({ playwright, baseURL }) => {
  requireSeedCredentials();
  origin = baseURL as string;
  johannaApi = await playwright.request.newContext({ httpCredentials: BASIC_AUTH_CREDENTIALS });
  await apiSignIn(johannaApi, 'johanna', origin);

  const workspace = await johannaApi.post(`${origin}/api/workspaces`, {
    data: { name: `Geteilter Chat ${Date.now().toString(36)}` },
    headers: { origin },
  });
  expect(workspace.status(), await workspace.text()).toBe(201);
  sharerWorkspaceId = ((await workspace.json()) as { id: string }).id;
  recordWorkspace(sharerWorkspaceId);

  const document = await johannaApi.post(
    `${origin}/api/workspaces/${sharerWorkspaceId}/documents`,
    { data: { title: marker, type: 'PAGE' }, headers: { origin } },
  );
  expect(document.status(), await document.text()).toBe(201);
  documentId = ((await document.json()) as { id: string }).id;

  const granted = await johannaApi.post(`${origin}/api/documents/${documentId}/shares`, {
    data: { kind: 'USER', email: SEED_USERS.stefan.email, permission: 'READ', scope: 'PAGE_ONLY' },
    headers: { origin },
  });
  expect(granted.status(), await granted.text()).toBe(201);
  shareId = ((await granted.json()) as { share: { id: string } }).share.id;
});

test.afterAll(async () => {
  await johannaApi.delete(`${origin}/api/shares/${shareId}`, { headers: { origin } });
  await johannaApi.dispose();
});

test.describe('KI-Chat auf einer geteilten Seite', () => {
  // The second test withdraws the grant the first one uses.
  test.describe.configure({ mode: 'serial', timeout: AI_TEST_TIMEOUT_MS });

  test("runs in the reader's own workspace and knows the shared page", async ({ page }) => {
    await page.goto(`/geteilt/${documentId}`);
    await page.getByTestId('context-tab-ai').click();

    const note = page.getByTestId('ai-shared-note');
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(note).toContainText('deinem Arbeitsbereich');

    await page.getByTestId('ai-input').fill('Wie heißt die geöffnete Seite? Nenne nur den Titel.');
    await page.getByTestId('ai-send').click();
    await waitForAiRun(page, 'shared-chat:ask');
    await expect(page.getByTestId('ai-panel')).toContainText(marker, { timeout: 30_000 });

    // The conversation is Stefan's and lives in one of his workspaces.
    const listed = await page.request.get(`/api/ai/conversations?documentId=${documentId}`);
    expect(listed.status(), await listed.text()).toBe(200);
    const { conversations } = (await listed.json()) as {
      conversations: { id: string; workspaceId: string; documentId: string | null }[];
    };
    expect(conversations).toHaveLength(1);
    const [conversation] = conversations;
    expect(conversation!.workspaceId).not.toBe(sharerWorkspaceId);

    const workspaces = await page.request.get('/api/workspaces');
    const own = ((await workspaces.json()) as { workspaces: { id: string }[] }).workspaces;
    expect(own.map((workspace) => workspace.id)).toContain(conversation!.workspaceId);

    // Gone again, so the next run of the suite starts from nothing.
    const deleted = await page.request.delete(
      `/api/ai/conversations/${conversation!.id}/permanent`,
      { headers: { origin } },
    );
    expect(deleted.ok(), await deleted.text()).toBe(true);
  });

  test('offers no chat on the page once the grant is gone', async ({ page }) => {
    const revoked = await johannaApi.delete(`${origin}/api/shares/${shareId}`, {
      headers: { origin },
    });
    expect(revoked.status()).toBe(200);

    await page.goto(`/geteilt/${documentId}`);
    await expect(page.getByText('Seite nicht verfügbar')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('ai-shared-note')).toHaveCount(0);
  });
});
