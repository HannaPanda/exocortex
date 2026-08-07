import { type APIRequestContext, expect, test } from '@playwright/test';

import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials, SEED_USERS } from '../support/fixtures';

/**
 * Sign-in is rate limited by design, so the suite authenticates once per user and
 * reuses the request contexts. Repeated logins would trip the limiter instead of
 * testing authorization.
 */
let johannaApi: APIRequestContext;
let stefanApi: APIRequestContext;
let anonymousApi: APIRequestContext;
let origin: string;

/**
 * Security scenarios, exercised against the real HTTP API.
 *
 * These are deliberately API-level rather than UI-level: hidden UI elements are
 * never an authorization mechanism, so every rule is verified where it is
 * enforced.
 */
test.beforeAll(async ({ playwright, baseURL }) => {
  requireSeedCredentials();
  origin = baseURL as string;
  const httpCredentials = {
    username: process.env.E2E_BASIC_USER ?? 'johanna',
    password: process.env.E2E_BASIC_PASSWORD ?? 'test123',
  };
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

/** Creates a workspace owned by Johanna and returns its id. */
async function createWorkspace(label: string): Promise<string> {
  const response = await johannaApi.post(`${origin}/api/workspaces`, {
    data: { name: `${label} ${Date.now().toString(36)}` },
    headers: { origin },
  });
  expect(response.status(), await response.text()).toBe(201);
  const { id } = (await response.json()) as { id: string };
  // Noted for the teardown: the application cannot delete a workspace, so a
  // suite that makes one per test would otherwise leave it there for good.
  recordWorkspace(id);
  return id;
}

/** Creates a page in a workspace owned by Johanna and returns its id. */
async function createDocument(
  workspaceId: string,
  data: Record<string, unknown>,
): Promise<string> {
  const response = await johannaApi.post(`${origin}/api/workspaces/${workspaceId}/documents`, {
    data,
    headers: { origin },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

test.describe('security', () => {
  test('unauthenticated document access is rejected', async () => {
    const response = await anonymousApi.get(`${origin}/api/documents/does-not-exist-at-all`);
    expect(response.status()).toBe(401);
    const body = (await response.json()) as { code: string; correlationId: string };
    expect(body.code).toBe('unauthenticated');
    // Every error carries a correlation id, and never a stack trace.
    expect(body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await response.text()).not.toContain('at ');
  });

  test('unauthenticated workspace listing is rejected', async () => {
    const response = await anonymousApi.get(`${origin}/api/workspaces`);
    expect(response.status()).toBe(401);
  });

  test('a foreign workspace is not readable', async () => {
    const workspaceId = await createWorkspace('Privat');

    const detail = await stefanApi.get(`${origin}/api/workspaces/${workspaceId}`);
    expect(detail.status()).toBe(403);
    expect(((await detail.json()) as { code: string }).code).toBe('workspace_access_denied');

    const tree = await stefanApi.get(`${origin}/api/workspaces/${workspaceId}/documents/tree`);
    expect(tree.status()).toBe(403);

    const search = await stefanApi.get(`${origin}/api/workspaces/${workspaceId}/search?q=test`);
    expect(search.status()).toBe(403);
  });

  test('a document from another workspace is not readable', async () => {
    const workspaceId = await createWorkspace('Geheim');
    const documentId = await createDocument(workspaceId, { title: 'Geheime Seite' });

    const read = await stefanApi.get(`${origin}/api/documents/${documentId}`);
    expect(read.status()).toBe(403);
    expect(((await read.json()) as { code: string }).code).toBe('document_access_denied');

    // Nor may an outsider request a collaboration ticket for it.
    const ticket = await stefanApi.post(
      `${origin}/api/documents/${documentId}/collaboration-ticket`,
      { headers: { origin } },
    );
    expect(ticket.status()).toBe(403);
  });

  test('a cross-workspace parent assignment is rejected', async () => {
    const firstWorkspace = await createWorkspace('WS-A');
    const secondWorkspace = await createWorkspace('WS-B');
    const pageInFirst = await createDocument(firstWorkspace, { title: 'A' });
    const pageInSecond = await createDocument(secondWorkspace, { title: 'B' });

    // Creating with a parent from another workspace.
    const createResponse = await johannaApi.post(
      `${origin}/api/workspaces/${firstWorkspace}/documents`,
      { data: { title: 'Fremd', parentId: pageInSecond }, headers: { origin } },
    );
    expect(createResponse.status()).toBe(422);
    expect(((await createResponse.json()) as { code: string }).code).toBe(
      'document_cross_workspace',
    );

    // Moving under a parent from another workspace.
    const moveResponse = await johannaApi.post(`${origin}/api/documents/${pageInFirst}/move`, {
      data: { parentId: pageInSecond },
      headers: { origin },
    });
    expect(moveResponse.status()).toBe(422);
    expect(((await moveResponse.json()) as { code: string }).code).toBe(
      'document_cross_workspace',
    );
  });

  test('a circular move is rejected', async () => {
    const workspaceId = await createWorkspace('Zyklus');
    const parentId = await createDocument(workspaceId, { title: 'Eltern' });
    const childId = await createDocument(workspaceId, { title: 'Kind', parentId });

    // Into itself.
    const intoSelf = await johannaApi.post(`${origin}/api/documents/${parentId}/move`, {
      data: { parentId },
      headers: { origin },
    });
    expect(intoSelf.status()).toBe(422);
    expect(((await intoSelf.json()) as { code: string }).code).toBe('document_move_cycle');

    // Into its own descendant.
    const intoDescendant = await johannaApi.post(`${origin}/api/documents/${parentId}/move`, {
      data: { parentId: childId },
      headers: { origin },
    });
    expect(intoDescendant.status()).toBe(422);
    expect(((await intoDescendant.json()) as { code: string }).code).toBe('document_move_cycle');
  });

  test('an archived document cannot be edited', async () => {
    const workspaceId = await createWorkspace('Archiv');
    const documentId = await createDocument(workspaceId, { title: 'Wird archiviert' });

    await johannaApi.post(`${origin}/api/documents/${documentId}/archive`, { headers: { origin } });

    const update = await johannaApi.patch(`${origin}/api/documents/${documentId}`, {
      data: { title: 'Neuer Titel' },
      headers: { origin },
    });
    expect(update.status()).toBe(409);
    expect(((await update.json()) as { code: string }).code).toBe('document_archived');

    // A ticket for an archived document is downgraded to read-only.
    const ticket = await johannaApi.post(
      `${origin}/api/documents/${documentId}/collaboration-ticket`,
      { headers: { origin } },
    );
    expect(ticket.status()).toBe(201);
    expect(((await ticket.json()) as { access: string }).access).toBe('read');
  });

  test('a collaboration ticket is scoped to one document and expires quickly', async () => {
    const workspaceId = await createWorkspace('Ticket');
    const documentId = await createDocument(workspaceId, { title: 'A' });

    const ticketResponse = await johannaApi.post(
      `${origin}/api/documents/${documentId}/collaboration-ticket`,
      { headers: { origin } },
    );
    const ticket = (await ticketResponse.json()) as {
      ticket: string;
      documentName: string;
      access: string;
      expiresAt: number;
    };

    // Scoped to exactly this document, opaque name, and short-lived.
    expect(ticket.documentName).toBe(documentId);
    expect(ticket.access).toBe('write');
    expect(ticket.expiresAt - Date.now()).toBeLessThanOrEqual(120_000);
    // The ticket name must not leak workspace or permission data.
    expect(ticket.documentName).not.toContain(workspaceId);
  });

  test('an unauthorized attachment download is rejected', async () => {
    const workspaceId = await createWorkspace('Dateien');

    // A 1x1 PNG, so the magic-byte check passes.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );
    const upload = await johannaApi.post(`${origin}/api/workspaces/${workspaceId}/attachments`, {
      multipart: { file: { name: 'pixel.png', mimeType: 'image/png', buffer: png } },
      headers: { origin },
    });
    expect(upload.status(), await upload.text()).toBe(201);
    const attachmentId = ((await upload.json()) as { attachment: { id: string } }).attachment.id;

    // The uploader can download it.
    const own = await johannaApi.get(`${origin}/api/attachments/${attachmentId}/download`);
    expect(own.status()).toBe(200);

    // A member of a different workspace cannot.
    const forbidden = await stefanApi.get(`${origin}/api/attachments/${attachmentId}/download`);
    expect(forbidden.status()).toBe(403);
    expect(((await forbidden.json()) as { code: string }).code).toBe('attachment_access_denied');

    // Unauthenticated is rejected as well.
    const unauthenticated = await anonymousApi.get(
      `${origin}/api/attachments/${attachmentId}/download`,
    );
    expect(unauthenticated.status()).toBe(401);
  });

  test('uploads reject a file whose real type is not allowed', async () => {
    const workspaceId = await createWorkspace('Upload');

    // An ELF binary announced as a PNG.
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00]);
    const response = await johannaApi.post(
      `${origin}/api/workspaces/${workspaceId}/attachments`,
      {
        multipart: { file: { name: 'harmless.png', mimeType: 'image/png', buffer: elf } },
        headers: { origin },
      },
    );
    expect(response.status()).toBe(415);
    expect(((await response.json()) as { code: string }).code).toBe('unsupported_media_type');
  });

  test('request validation rejects malformed payloads', async () => {
    const workspaceId = await createWorkspace('Validierung');

    const response = await johannaApi.post(
      `${origin}/api/workspaces/${workspaceId}/documents`,
      { data: { title: '', type: 'KANBAN' }, headers: { origin } },
    );
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { code: string; details: unknown };
    expect(body.code).toBe('validation_failed');
    expect(Array.isArray(body.details)).toBe(true);
  });

  test('security headers and health endpoints are in place', async () => {
    const health = await anonymousApi.get(`${origin}/health/live`);
    expect(health.status()).toBe(200);

    const ready = await anonymousApi.get(`${origin}/health/ready`);
    expect(ready.status()).toBe(200);
    const readiness = (await ready.json()) as {
      status: string;
      checks: Record<string, string>;
    };
    expect(readiness.status).toBe('ok');
    expect(readiness.checks.database).toBe('ok');
    expect(readiness.checks.redis).toBe('ok');
    expect(readiness.checks.objectStorage).toBe('ok');

    // nginx and the application both set the header (defence in depth), so the
    // proxied response can legitimately contain it twice.
    const page = await anonymousApi.get(`${origin}/anmelden`);
    expect(page.headers()['x-content-type-options']).toContain('nosniff');
    expect(page.headers()['strict-transport-security']).toBeDefined();
  });

  test('the signed-in session reports the correct account', async () => {
    const session = (await (await stefanApi.get(`${origin}/api/session`)).json()) as {
      user: { email: string };
    };
    expect(session.user.email).toBe(SEED_USERS.stefan.email);
  });
});
