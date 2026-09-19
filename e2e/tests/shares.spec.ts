import { type APIRequestContext, expect, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials, SEED_USERS } from '../support/fixtures';

/**
 * Page shares and page-scoped tokens over real HTTP (issue #83, ADR-044).
 *
 * API-level rather than through the browser, for the reason `security.spec.ts`
 * gives: hidden UI is never an authorization mechanism. What is worth checking
 * out here rather than in the integration tests is the part that only exists
 * over the wire -- a caller with no session at all reaching a link, a second
 * account reaching a page in a workspace it is not in, and a bearer token that
 * was issued narrower than the account behind it.
 */
let johannaApi: APIRequestContext;
let stefanApi: APIRequestContext;
let anonymousApi: APIRequestContext;
let origin: string;

test.beforeAll(async ({ playwright, baseURL }) => {
  requireSeedCredentials();
  origin = baseURL as string;
  const httpCredentials = BASIC_AUTH_CREDENTIALS;
  johannaApi = await playwright.request.newContext({ httpCredentials });
  stefanApi = await playwright.request.newContext({ httpCredentials });
  anonymousApi = await playwright.request.newContext({ httpCredentials });
  await apiSignIn(johannaApi, 'johanna', origin);
  await apiSignIn(stefanApi, 'stefan', origin);
});

test.afterAll(async () => {
  await johannaApi.dispose();
  await stefanApi.dispose();
  await anonymousApi.dispose();
});

async function createWorkspace(label: string): Promise<string> {
  const response = await johannaApi.post(`${origin}/api/workspaces`, {
    data: { name: `${label} ${Date.now().toString(36)}` },
    headers: { origin },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { id } = (await response.json()) as { id: string };
  recordWorkspace(id);
  return id;
}

async function createDocument(
  workspaceId: string,
  title: string,
  parentId?: string,
): Promise<string> {
  const response = await johannaApi.post(`${origin}/api/workspaces/${workspaceId}/documents`, {
    data: { title, type: 'PAGE', ...(parentId === undefined ? {} : { parentId }) },
    headers: { origin },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

interface ShareBody {
  share: { id: string; token: string | null; tokenPrefix: string | null };
}

async function share(
  documentId: string,
  data: Record<string, unknown>,
): Promise<ShareBody['share']> {
  const response = await johannaApi.post(`${origin}/api/documents/${documentId}/shares`, {
    data,
    headers: { origin },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as ShareBody).share;
}

test.describe('shares', () => {
  test('a public link serves the page to somebody with no session at all', async () => {
    const workspaceId = await createWorkspace('Freigabe Link');
    const documentId = await createDocument(workspaceId, 'Öffentlich');
    const created = await share(documentId, { kind: 'PUBLIC_LINK', scope: 'PAGE_ONLY' });
    expect(created.token).not.toBeNull();

    const anonymous = await anonymousApi.get(`${origin}/api/share/${created.token ?? ''}`);
    expect(anonymous.status(), await anonymous.text()).toBe(200);
    const body = (await anonymous.json()) as { page: { title: string; workspaceName: string } };
    expect(body.page.title).toBe('Öffentlich');
    // The workspace's *name* is part of what a link says about itself; its id
    // is not in the schema at all.
    expect(await anonymous.text()).not.toContain(workspaceId);
  });

  test('a withdrawn link answers exactly like a guessed one', async () => {
    const workspaceId = await createWorkspace('Freigabe Widerruf');
    const documentId = await createDocument(workspaceId, 'Zurückgezogen');
    const created = await share(documentId, { kind: 'PUBLIC_LINK', scope: 'PAGE_ONLY' });

    const revoked = await johannaApi.delete(`${origin}/api/shares/${created.id}`, {
      headers: { origin },
    });
    expect(revoked.status()).toBe(200);

    const afterwards = await anonymousApi.get(`${origin}/api/share/${created.token ?? ''}`);
    const guessed = await anonymousApi.get(`${origin}/api/share/${'z'.repeat(43)}`);
    expect(afterwards.status()).toBe(404);
    expect(guessed.status()).toBe(404);
    expect(((await afterwards.json()) as { code: string }).code).toBe('share_link_invalid');
    expect(((await guessed.json()) as { code: string }).code).toBe('share_link_invalid');
  });

  test('a link never carries write access, and the route has no write at all', async () => {
    const workspaceId = await createWorkspace('Freigabe schreibgeschützt');
    const documentId = await createDocument(workspaceId, 'Nur lesen');
    const refused = await johannaApi.post(`${origin}/api/documents/${documentId}/shares`, {
      data: { kind: 'PUBLIC_LINK', permission: 'WRITE', scope: 'PAGE_ONLY' },
      headers: { origin },
    });
    expect(refused.status()).toBe(400);

    const created = await share(documentId, { kind: 'PUBLIC_LINK', scope: 'PAGE_ONLY' });
    const write = await anonymousApi.post(`${origin}/api/share/${created.token ?? ''}`, {
      data: { markdown: 'nein' },
      headers: { origin },
    });
    expect(write.status()).toBe(404);
  });

  test('a share reaches one account without letting it into the workspace', async () => {
    const workspaceId = await createWorkspace('Freigabe Konto');
    const sectionId = await createDocument(workspaceId, 'Bereich');
    const documentId = await createDocument(workspaceId, 'Geteilt', sectionId);
    const secretId = await createDocument(workspaceId, 'Geheim');

    // Before the share: Stefan reaches nothing here.
    expect((await stefanApi.get(`${origin}/api/documents/${documentId}`)).status()).toBe(403);

    await share(documentId, {
      kind: 'USER',
      email: SEED_USERS.stefan.email,
      permission: 'READ',
      scope: 'PAGE_ONLY',
    });

    const page = await stefanApi.get(`${origin}/api/documents/${documentId}`);
    expect(page.status(), await page.text()).toBe(200);
    const detail = (await page.json()) as {
      breadcrumb: unknown[];
      canShare: boolean;
      viaShare: boolean;
      access: string;
    };
    expect(detail.viaShare).toBe(true);
    expect(detail.canShare).toBe(false);
    expect(detail.access).toBe('read');
    // The section above it was not shared, so it is not in the breadcrumb and
    // not reachable.
    expect(detail.breadcrumb).toEqual([]);
    expect((await stefanApi.get(`${origin}/api/documents/${sectionId}`)).status()).toBe(403);
    expect((await stefanApi.get(`${origin}/api/documents/${secretId}`)).status()).toBe(403);
    // And the workspace itself stays closed: no tree, no search, no settings.
    expect(
      (await stefanApi.get(`${origin}/api/workspaces/${workspaceId}/documents/tree`)).status(),
    ).toBe(403);
    expect(
      (await stefanApi.get(`${origin}/api/workspaces/${workspaceId}/search?q=Geheim`)).status(),
    ).toBe(403);
  });

  test('the recipient finds the page in their own list and nowhere else', async () => {
    const workspaceId = await createWorkspace('Freigabe Liste');
    const documentId = await createDocument(workspaceId, 'In der Liste');
    await share(documentId, {
      kind: 'USER',
      email: SEED_USERS.stefan.email,
      permission: 'READ',
      scope: 'PAGE_ONLY',
    });

    const incoming = await stefanApi.get(`${origin}/api/me/shares`);
    expect(incoming.status()).toBe(200);
    const body = (await incoming.json()) as { shares: { document: { id: string } }[] };
    expect(body.shares.some((entry) => entry.document.id === documentId)).toBe(true);

    // The page is in no workspace list of theirs, because they are in no such
    // workspace.
    const workspaces = (await (await stefanApi.get(`${origin}/api/workspaces`)).json()) as {
      id: string;
    }[];
    expect(workspaces.some((workspace) => workspace.id === workspaceId)).toBe(false);
  });

  test('a page-scoped token reaches its branch and refuses the workspace', async () => {
    const workspaceId = await createWorkspace('Token Bereich');
    const sectionId = await createDocument(workspaceId, 'Cyberpunk');
    const childId = await createDocument(workspaceId, 'Konzerne', sectionId);
    const secretId = await createDocument(workspaceId, 'Steuer');

    const tokenResponse = await johannaApi.post(`${origin}/api/me/api-tokens`, {
      data: {
        name: `Scoped ${Date.now().toString(36)}`,
        scopes: ['read'],
        pageScopes: [{ documentId: sectionId, scope: 'SUBTREE' }],
        expiresInDays: 1,
      },
      headers: { origin },
    });
    expect(tokenResponse.status(), await tokenResponse.text()).toBe(201);
    const { secret, token } = (await tokenResponse.json()) as {
      secret: string;
      token: { id: string; pageScopes: { documentId: string }[] };
    };
    expect(token.pageScopes.map((entry) => entry.documentId)).toEqual([sectionId]);

    const headers = { Authorization: `Bearer ${secret}` };
    expect(
      (await anonymousApi.get(`${origin}/api/documents/${sectionId}`, { headers })).status(),
    ).toBe(200);
    expect(
      (await anonymousApi.get(`${origin}/api/documents/${childId}`, { headers })).status(),
    ).toBe(200);
    expect(
      (await anonymousApi.get(`${origin}/api/documents/${secretId}`, { headers })).status(),
    ).toBe(403);

    // A workspace-wide question is refused rather than filtered.
    const settings = await anonymousApi.get(`${origin}/api/workspaces/${workspaceId}`, { headers });
    expect(settings.status()).toBe(403);
    expect(((await settings.json()) as { code: string }).code).toBe('token_scope_exceeded');

    // Search is one of the readers that narrows instead.
    const search = await anonymousApi.get(
      `${origin}/api/workspaces/${workspaceId}/search?q=Steuer`,
      { headers },
    );
    expect(search.status(), await search.text()).toBe(200);
    const hits = (await search.json()) as { results: { documentId: string }[] };
    expect(hits.results.some((hit) => hit.documentId === secretId)).toBe(false);

    // And it cannot widen itself by minting a token without a confinement.
    const widened = await anonymousApi.post(`${origin}/api/me/api-tokens`, {
      data: { name: 'Weiter', scopes: ['read'], pageScopes: [], expiresInDays: 1 },
      headers: { ...headers, origin },
    });
    expect(widened.status()).toBe(403);

    await johannaApi.delete(`${origin}/api/me/api-tokens/${token.id}`, { headers: { origin } });
  });
});
