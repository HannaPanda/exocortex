import { type APIRequestContext, expect, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials, SEED_USERS } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * „Mit mir geteilt“ in der Seitenleiste (Issue #232).
 *
 * Zwei Konten: das eine teilt aus einem Wegwerf-Arbeitsbereich, in dem das
 * andere kein Mitglied ist, das andere findet die Seite in seiner eigenen
 * Seitenleiste. Geprüft wird, was nur im Browser existiert: dass der Eintrag
 * dort steht und sagt, woher er kommt, ohne die Seite darüber zu nennen, dass
 * die geteilte Ansicht selbst eine Navigation hat, und dass ein Widerruf den
 * Eintrag entfernt, ohne dass jemand neu lädt.
 */

test.use({ storageState: storageStatePath('stefan') });

let sharer: APIRequestContext;
let origin: string;
let workspaceId: string;
let workspaceName: string;

test.beforeAll(async ({ playwright, baseURL }) => {
  requireSeedCredentials();
  origin = baseURL as string;
  sharer = await playwright.request.newContext({ httpCredentials: BASIC_AUTH_CREDENTIALS });
  await apiSignIn(sharer, 'johanna', origin);

  workspaceName = `Geteilt Seitenleiste ${Date.now().toString(36)}`;
  const created = await sharer.post(`${origin}/api/workspaces`, { data: { name: workspaceName } });
  expect(created.ok(), await created.text()).toBe(true);
  workspaceId = ((await created.json()) as { id: string }).id;
  recordWorkspace(workspaceId);
});

test.afterAll(async () => {
  await sharer.dispose();
});

async function createDocument(title: string, parentId: string | null = null): Promise<string> {
  const response = await sharer.post(`${origin}/api/workspaces/${workspaceId}/documents`, {
    data: { title, type: 'PAGE', parentId },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function shareWithStefan(
  documentId: string,
  scope: 'PAGE_ONLY' | 'SUBTREE',
): Promise<string> {
  const response = await sharer.post(`${origin}/api/documents/${documentId}/shares`, {
    data: { kind: 'USER', email: SEED_USERS.stefan.email, permission: 'READ', scope },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { share: { id: string } }).share.id;
}

test.describe('shared with me in the navigation', () => {
  test('lists the page with its origin, opens it, and drops it when withdrawn', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const parentTitle = `Oberseite ${suffix}`;
    const parentId = await createDocument(parentTitle);
    const sharedTitle = `Seitenleiste ${suffix}`;
    const documentId = await createDocument(sharedTitle, parentId);
    const shareId = await shareWithStefan(documentId, 'PAGE_ONLY');

    // Stefan's own workspace: the section stands below his own tree.
    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[^/]+$/);
    const section = page.getByTestId('sidebar').getByTestId('shared-with-me-nav');
    const entry = section.getByTestId(`shared-with-me-${documentId}`);
    await expect(entry).toContainText(sharedTitle);
    await expect(entry).toContainText(workspaceName);
    // Where it came from, and nothing about what it sits under.
    await expect(section).not.toContainText(parentTitle);

    // A page shared on its own has nothing to unfold.
    await expect(entry.getByTestId('shared-with-me-toggle')).toHaveCount(0);

    await entry.getByRole('link').click();
    await page.waitForURL(`**/geteilt/${documentId}`);

    // The shared view has a navigation of its own now: the same list, with
    // this page marked, and the way back into a workspace of his.
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar.getByTestId('own-workspaces-nav')).toBeVisible();
    await expect(
      sidebar.getByTestId(`shared-with-me-${documentId}`).getByRole('link'),
    ).toHaveAttribute('aria-current', 'page');
    await expect(sidebar).not.toContainText(parentTitle);

    // Withdrawn while open: the entry leaves without a reload.
    const revoked = await sharer.delete(`${origin}/api/shares/${shareId}`, {
      headers: { origin },
    });
    expect(revoked.ok(), await revoked.text()).toBe(true);
    await expect(sidebar.getByTestId(`shared-with-me-${documentId}`)).toHaveCount(0, {
      timeout: 20_000,
    });
  });

  test('unfolds a shared branch, stays in the shared view, and folds it away when withdrawn', async ({
    page,
  }) => {
    const suffix = Date.now().toString(36);
    const aboveTitle = `Darüber ${suffix}`;
    const besideTitle = `Daneben ${suffix}`;
    const rootTitle = `Zweig ${suffix}`;
    const childTitle = `Kind ${suffix}`;
    const grandchildTitle = `Enkel ${suffix}`;
    const aboveId = await createDocument(aboveTitle);
    await createDocument(besideTitle, aboveId);
    const rootId = await createDocument(rootTitle, aboveId);
    const childId = await createDocument(childTitle, rootId);
    const grandchildId = await createDocument(grandchildTitle, childId);
    const written = await sharer.post(`${origin}/api/documents/${rootId}/content`, {
      headers: { origin },
      data: { markdown: `Weiter zu [[${childTitle}]].`, mode: 'replace' },
    });
    expect(written.ok(), await written.text()).toBe(true);
    const shareId = await shareWithStefan(rootId, 'SUBTREE');

    await page.goto('/arbeitsbereich');
    await page.waitForURL(/\/arbeitsbereich\/[^/]+$/);
    const sidebar = page.getByTestId('sidebar');
    const entry = sidebar.getByTestId(`shared-with-me-${rootId}`);
    await expect(entry).toContainText(rootTitle);

    // Two clicks from the sidebar to a page below the shared one.
    await entry.getByTestId('shared-with-me-toggle').first().click();
    const child = entry.getByTestId(`shared-branch-${childId}`);
    await expect(child).toContainText(childTitle);
    await child.getByRole('link', { name: childTitle }).click();
    await page.waitForURL(`**/geteilt/${childId}`);

    // The shared view draws the branch from the shared page down, with the
    // open page marked and the way to it unfolded; nothing above or beside.
    const branchEntry = sidebar.getByTestId(`shared-with-me-${rootId}`);
    await expect(
      branchEntry.getByTestId(`shared-branch-${childId}`).getByRole('link', { name: childTitle }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(branchEntry.getByTestId(`shared-branch-${grandchildId}`)).toContainText(
      grandchildTitle,
    );
    await expect(sidebar).not.toContainText(aboveTitle);
    await expect(sidebar).not.toContainText(besideTitle);
    await expect(page.locator('body')).not.toContainText(aboveTitle);

    // A link on the shared page to a page of the same share stays in the
    // shared view.
    await page.goto(`/geteilt/${rootId}`);
    const link = page.getByTestId('editor-surface').getByRole('link', { name: childTitle });
    // A wiki link keeps its `wiki:` address in the document; where a click
    // takes it is decided when it is followed.
    await expect(link).toHaveAttribute('data-document-id', childId);
    await link.click();
    await page.waitForURL(`**/geteilt/${childId}`);

    // Withdrawn while open: the entry and its branch leave without a reload,
    // and the branch is no longer answered.
    const revoked = await sharer.delete(`${origin}/api/shares/${shareId}`, {
      headers: { origin },
    });
    expect(revoked.ok(), await revoked.text()).toBe(true);
    await expect(sidebar.getByTestId(`shared-with-me-${rootId}`)).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(sidebar.getByTestId(`shared-branch-${childId}`)).toHaveCount(0);
    const tree = await page.request.get(
      `/api/workspaces/${workspaceId}/documents/tree?parentId=${rootId}`,
    );
    expect(tree.status()).toBe(403);
  });
});
