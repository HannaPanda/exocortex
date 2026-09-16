import { HocuspocusProvider } from '@hocuspocus/provider';
import { type Server } from '@hocuspocus/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';

import { issueCollaborationTicket, issueServiceToken } from '@exocortex/auth';
import { loadCollaborationEnv } from '@exocortex/config';
import { collaborationApplyPath, type CollaborationApplyRequest } from '@exocortex/contracts';
import { createPrismaClient, generateOrderKey, type PrismaClient } from '@exocortex/database';
import {
  createEmptyYjsState,
  markdownToYjsState,
  parseMarkdown,
  serializePlainText,
  YJS_DOCUMENT_FIELD,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';
import { createLogger } from '@exocortex/logger';
import { QueueRegistry, RedisRevocationBus, testQueuePrefix } from '@exocortex/queue';

import { type CollaborationRuntime, createCollaborationServer } from './server';

/**
 * Collaboration integration tests.
 *
 * These run against the real PostgreSQL and Redis from `pnpm infra:up` and start
 * real Hocuspocus servers. They cover the guarantees that cannot be observed from
 * the browser suite:
 *
 *  * "persists the binary Yjs state and survives a full server restart"
 *  * "rejects a ticket for a different document"
 *  * "rejects an expired ticket"
 *  * "refuses updates from a read-only connection"
 */
const env = loadCollaborationEnv();
const logger = createLogger({ name: 'collaboration-test', level: 'silent' });

const TEST_PORT = 3399;
const TICKET_SECRET = env.COLLABORATION_TICKET_SECRET;

let prisma: PrismaClient;
let queues: QueueRegistry;
let workspaceId: string;
let userId: string;
let documentId: string;

/** Waits until `predicate` holds or the timeout elapses. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
}

function startRuntime(): CollaborationRuntime {
  return createCollaborationServer({
    prisma,
    queues,
    logger,
    ticketSecret: TICKET_SECRET,
    port: TEST_PORT,
    address: '127.0.0.1',
    // Keep the test fast; the debounce behaviour itself is unit tested.
    storeDebounceMs: 200,
    storeMaxDebounceMs: 500,
    redisUrl: env.REDIS_URL,
    // The sweeps in these tests are triggered by hand, so the timer must not
    // fire underneath an assertion.
    revocationRecheckIntervalMs: 600_000,
  });
}

/** For the tests that never touch revocations. `destroy()` closes both halves. */
function startServer(): Server {
  return startRuntime().server;
}

function connect(input: { ticket: string; name: string; document: Y.Doc }): HocuspocusProvider {
  return new HocuspocusProvider({
    url: `ws://127.0.0.1:${TEST_PORT}`,
    name: input.name,
    token: input.ticket,
    document: input.document,
    // Node has no global WebSocket in the version range we support explicitly.
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    connect: true,
  });
}

/** Calls the private endpoint the REST API uses to reach an open session. */
async function applyContent(input: {
  documentId: string;
  markdown: string;
  mode: CollaborationApplyRequest['mode'];
  token?: string;
}): Promise<Response> {
  const token =
    input.token ??
    issueServiceToken({
      secret: TICKET_SECRET,
      userId,
      purpose: 'collaboration-write',
      ttlSeconds: 60,
    }).token;

  return fetch(`http://127.0.0.1:${TEST_PORT}${collaborationApplyPath(input.documentId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      proseMirrorJson: parseMarkdown(input.markdown).document,
      mode: input.mode,
      correlationId: 'test-correlation',
    } satisfies CollaborationApplyRequest),
  });
}

function ticketFor(
  target: string,
  access: 'read' | 'write',
  ttlSeconds = 60,
  now?: number,
  forUserId?: string,
): string {
  return issueCollaborationTicket({
    secret: TICKET_SECRET,
    userId: forUserId ?? userId,
    documentId: target,
    access,
    ttlSeconds,
    ...(now === undefined ? {} : { now }),
  }).ticket;
}

/** A page of its own, so one test's writes cannot be another's evidence. */
async function createPage(title: string): Promise<string> {
  const page = await prisma.document.create({
    data: {
      workspaceId,
      title,
      orderKey: generateOrderKey(null, null),
      createdById: userId,
      updatedById: userId,
      content: { create: { yjsState: Buffer.from(createEmptyYjsState()) } },
    },
  });
  return page.id;
}

/** A second member, so access can be taken away from somebody. */
async function createMember(role: 'MEMBER' | 'GUEST'): Promise<string> {
  const member = await prisma.user.create({
    data: {
      email: `collab-member-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@exocortex.test`,
      name: 'Zweites Mitglied',
      emailVerified: true,
    },
  });
  await prisma.workspaceMember.create({ data: { workspaceId, userId: member.id, role } });
  return member.id;
}

function appendParagraph(ydoc: Y.Doc, text: string): void {
  const fragment = ydoc.get(YJS_DOCUMENT_FIELD, Y.XmlFragment);
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(fragment.length, [paragraph]);
}

async function storedText(documentId: string): Promise<string> {
  const content = await prisma.documentContent.findUniqueOrThrow({
    where: { documentId },
    select: { yjsState: true },
  });
  return JSON.stringify(yjsStateToProseMirrorJson(content.yjsState));
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: env.REDIS_URL,
    logger,
    prefix: testQueuePrefix('collaboration'),
  });

  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: { email: `collab-${suffix}@exocortex.test`, name: 'Collab Test', emailVerified: true },
  });
  userId = user.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Collab ${suffix}`,
      slug: `collab-${suffix}`,
      members: { create: { userId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;

  const document = await prisma.document.create({
    data: {
      workspaceId,
      title: 'Integrationstest',
      orderKey: generateOrderKey(null, null),
      createdById: userId,
      updatedById: userId,
      content: { create: { yjsState: Buffer.from(createEmptyYjsState()) } },
    },
  });
  documentId = document.id;
}, 60_000);

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

describe('collaboration server', () => {
  it('persists the binary Yjs state and survives a full server restart', async () => {
    const marker = `restart-${Date.now().toString(36)}`;

    // --- first server generation -------------------------------------------
    const first = startServer();
    await first.listen();

    const documentA = new Y.Doc();
    const providerA = connect({
      ticket: ticketFor(documentId, 'write'),
      name: documentId,
      document: documentA,
    });
    await waitFor(() => providerA.isSynced);

    const fragment = documentA.get(YJS_DOCUMENT_FIELD, Y.XmlFragment);
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(marker)]);
    fragment.insert(fragment.length, [paragraph]);

    // Wait until the debounced store hook wrote the state to PostgreSQL.
    await waitFor(async () => {
      const content = await prisma.documentContent.findUnique({
        where: { documentId },
        select: { yjsState: true },
      });
      if (content === null) return false;
      const derived = yjsStateToProseMirrorJson(content.yjsState);
      return JSON.stringify(derived).includes(marker);
    }, 20_000);

    providerA.destroy();
    documentA.destroy();
    await first.destroy();

    // --- second server generation (a real restart) --------------------------
    const second = startServer();
    await second.listen();

    const documentB = new Y.Doc();
    const providerB = connect({
      ticket: ticketFor(documentId, 'write'),
      name: documentId,
      document: documentB,
    });
    await waitFor(() => providerB.isSynced);

    const restored = documentB.get(YJS_DOCUMENT_FIELD, Y.XmlFragment).toJSON();
    expect(restored).toContain(marker);

    providerB.destroy();
    documentB.destroy();
    await second.destroy();
  }, 90_000);

  it('rejects a ticket issued for a different document', async () => {
    const server = startServer();
    await server.listen();

    const other = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Andere Seite',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
        content: { create: { yjsState: Buffer.from(createEmptyYjsState()) } },
      },
    });

    const ydoc = new Y.Doc();
    const provider = connect({
      // A valid ticket, but for the *other* document.
      ticket: ticketFor(other.id, 'write'),
      name: documentId,
      document: ydoc,
    });

    let authenticationFailed = false;
    provider.on('authenticationFailed', () => {
      authenticationFailed = true;
    });

    await waitFor(() => authenticationFailed, 15_000);
    expect(authenticationFailed).toBe(true);
    expect(provider.isSynced).toBe(false);

    provider.destroy();
    ydoc.destroy();
    await server.destroy();
  }, 60_000);

  it('rejects an expired ticket', async () => {
    const server = startServer();
    await server.listen();

    const ydoc = new Y.Doc();
    const provider = connect({
      // Issued two minutes ago with a 60 second lifetime.
      ticket: ticketFor(documentId, 'write', 60, Date.now() - 120_000),
      name: documentId,
      document: ydoc,
    });

    let authenticationFailed = false;
    provider.on('authenticationFailed', () => {
      authenticationFailed = true;
    });

    await waitFor(() => authenticationFailed, 15_000);
    expect(authenticationFailed).toBe(true);

    provider.destroy();
    ydoc.destroy();
    await server.destroy();
  }, 60_000);

  it('refuses updates from a read-only connection', async () => {
    const server = startServer();
    await server.listen();

    const readOnlyDocument = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Nur lesbar',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
        content: { create: { yjsState: Buffer.from(createEmptyYjsState()) } },
      },
    });

    const ydoc = new Y.Doc();
    const provider = connect({
      ticket: ticketFor(readOnlyDocument.id, 'read'),
      name: readOnlyDocument.id,
      document: ydoc,
    });
    await waitFor(() => provider.isSynced);

    const fragment = ydoc.get(YJS_DOCUMENT_FIELD, Y.XmlFragment);
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('darf nicht gespeichert werden')]);
    fragment.insert(fragment.length, [paragraph]);

    // Give the server more than one debounce window to (not) store the update.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const content = await prisma.documentContent.findUniqueOrThrow({
      where: { documentId: readOnlyDocument.id },
      select: { yjsState: true },
    });
    const derived = JSON.stringify(yjsStateToProseMirrorJson(content.yjsState));
    expect(derived).not.toContain('darf nicht gespeichert werden');

    provider.destroy();
    ydoc.destroy();
    await server.destroy();
  }, 60_000);

  it('rejects a write ticket for an archived document by downgrading to read-only', async () => {
    const server = startServer();
    await server.listen();

    const archived = await prisma.document.create({
      data: {
        workspaceId,
        title: 'Archiviert',
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
        archivedAt: new Date(),
        content: { create: { yjsState: Buffer.from(createEmptyYjsState()) } },
      },
    });

    const ydoc = new Y.Doc();
    const provider = connect({
      // Even a `write` ticket must not grant write access to an archived page.
      ticket: ticketFor(archived.id, 'write'),
      name: archived.id,
      document: ydoc,
    });
    await waitFor(() => provider.isSynced);

    const fragment = ydoc.get(YJS_DOCUMENT_FIELD, Y.XmlFragment);
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('archivierte Änderung')]);
    fragment.insert(fragment.length, [paragraph]);
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const content = await prisma.documentContent.findUniqueOrThrow({
      where: { documentId: archived.id },
      select: { yjsState: true },
    });
    expect(JSON.stringify(yjsStateToProseMirrorJson(content.yjsState))).not.toContain(
      'archivierte Änderung',
    );

    provider.destroy();
    ydoc.destroy();
    await server.destroy();
  }, 60_000);
});

/**
 * Issue #62: authorization is decided at the handshake, and a tab holds its
 * connection for hours. These two tests work on a connection that is *already
 * open* -- a test that only refuses a fresh connect after the change would pass
 * against the bug.
 */
describe('withdrawing access from an open connection', () => {
  it('ends a writable session when the member is removed from the workspace', async () => {
    const runtime = startRuntime();
    await runtime.server.listen();
    await runtime.revocations.ready;

    const memberId = await createMember('MEMBER');
    const pageId = await createPage('Entzug während der Sitzung');

    const ydoc = new Y.Doc();
    const provider = connect({
      ticket: ticketFor(pageId, 'write', 60, undefined, memberId),
      name: pageId,
      document: ydoc,
    });
    await waitFor(() => provider.isSynced);

    // The membership goes, and the API says so on the revocation channel.
    await prisma.workspaceMember.deleteMany({ where: { workspaceId, userId: memberId } });
    const bus = new RedisRevocationBus({ redisUrl: env.REDIS_URL, logger });
    await bus.publish({
      userId: memberId,
      workspaceId,
      reason: 'workspace_membership_removed',
      emittedAt: new Date().toISOString(),
      correlationId: 'test',
    });

    // The connection is closed, and the reconnect the client tries by itself is
    // refused -- which is the same door every other caller now finds locked.
    await waitFor(() => !provider.isSynced, 20_000);

    appendParagraph(ydoc, 'nach dem Entzug geschrieben');
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await storedText(pageId)).not.toContain('nach dem Entzug geschrieben');

    provider.destroy();
    ydoc.destroy();
    await bus.close();
    await runtime.server.destroy();
    await prisma.user.delete({ where: { id: memberId } });
  }, 90_000);

  it('takes the write right off an open connection when the role drops to read-only', async () => {
    const runtime = startRuntime();
    await runtime.server.listen();

    const memberId = await createMember('MEMBER');
    const pageId = await createPage('Herabstufung während der Sitzung');

    const ydoc = new Y.Doc();
    const provider = connect({
      ticket: ticketFor(pageId, 'write', 60, undefined, memberId),
      name: pageId,
      document: ydoc,
    });
    await waitFor(() => provider.isSynced);

    appendParagraph(ydoc, 'als Mitglied geschrieben');
    await waitFor(async () => (await storedText(pageId)).includes('als Mitglied geschrieben'));

    // Demoted to GUEST, which `resolveCollaborationAccess` answers with `read`.
    await prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId: memberId } },
      data: { role: 'GUEST' },
    });
    // The sweep rather than the channel: this is the net that catches a
    // revocation nobody delivered, and it must reach the same conclusion.
    await runtime.revocations.recheck();

    appendParagraph(ydoc, 'als Gast geschrieben');
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const stored = await storedText(pageId);
    expect(stored).toContain('als Mitglied geschrieben');
    expect(stored).not.toContain('als Gast geschrieben');

    provider.destroy();
    ydoc.destroy();
    await runtime.server.destroy();
    await prisma.workspaceMember.deleteMany({ where: { workspaceId, userId: memberId } });
    await prisma.user.delete({ where: { id: memberId } });
  }, 90_000);

  it('closes the connections of an account that was switched off', async () => {
    const runtime = startRuntime();
    await runtime.server.listen();

    const memberId = await createMember('MEMBER');
    const pageId = await createPage('Konto abgeschaltet');

    const ydoc = new Y.Doc();
    const provider = connect({
      ticket: ticketFor(pageId, 'write', 60, undefined, memberId),
      name: pageId,
      document: ydoc,
    });
    await waitFor(() => provider.isSynced);

    await prisma.user.update({ where: { id: memberId }, data: { disabledAt: new Date() } });
    await runtime.revocations.recheck();

    await waitFor(() => !provider.isSynced, 20_000);

    appendParagraph(ydoc, 'nach dem Abschalten geschrieben');
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(await storedText(pageId)).not.toContain('nach dem Abschalten geschrieben');

    provider.destroy();
    ydoc.destroy();
    await runtime.server.destroy();
    await prisma.workspaceMember.deleteMany({ where: { workspaceId, userId: memberId } });
    await prisma.user.delete({ where: { id: memberId } });
  }, 90_000);
});

describe('health probes', () => {
  it('answers both probes without disturbing the process', async () => {
    const server = startServer();
    await server.listen();

    const live = await fetch(`http://127.0.0.1:${TEST_PORT}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });

    const ready = await fetch(`http://127.0.0.1:${TEST_PORT}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ok' });

    await server.destroy();
  }, 60_000);
});

/**
 * The private endpoint the REST API uses so a write that did not come from an
 * editor reaches an open session instead of racing its next autosave (ADR-016).
 */
describe('internal content endpoint', () => {
  /** A page with content of its own, so a replace has something to remove. */
  async function createPage(title: string, markdown: string, archived = false): Promise<string> {
    const document = await prisma.document.create({
      data: {
        workspaceId,
        title,
        orderKey: generateOrderKey(null, null),
        createdById: userId,
        updatedById: userId,
        ...(archived ? { archivedAt: new Date() } : {}),
        content: { create: { yjsState: Buffer.from(markdownToYjsState(markdown).yjsState) } },
      },
    });
    return document.id;
  }

  async function storedText(target: string): Promise<string> {
    const content = await prisma.documentContent.findUniqueOrThrow({
      where: { documentId: target },
      select: { yjsState: true },
    });
    return serializePlainText(yjsStateToProseMirrorJson(content.yjsState));
  }

  it('applies a replace to the open session and persists it right away', async () => {
    const server = startServer();
    await server.listen();
    const page = await createPage('Offen beim Schreiben', 'Alter Inhalt.\n');

    const ydoc = new Y.Doc();
    const provider = connect({ ticket: ticketFor(page, 'write'), name: page, document: ydoc });
    await waitFor(() => provider.isSynced);

    const response = await applyContent({
      documentId: page,
      markdown: 'Vom Agenten geschrieben.\n',
      mode: 'replace',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { applied: boolean; clientsCount: number };
    expect(body.applied).toBe(true);
    expect(body.clientsCount).toBe(1);

    // The editor sees it without reconnecting …
    await waitFor(() =>
      ydoc.get(YJS_DOCUMENT_FIELD, Y.XmlFragment).toJSON().includes('Vom Agenten geschrieben.'),
    );
    // … and the database already has it, not only after the next debounce.
    const persisted = await storedText(page);
    expect(persisted).toContain('Vom Agenten geschrieben.');
    expect(persisted).not.toContain('Alter Inhalt.');

    provider.destroy();
    ydoc.destroy();
    await server.destroy();
  }, 60_000);

  /** The reason the mode is carried through instead of always replacing. */
  it('keeps what a human is typing when content is appended', async () => {
    const server = startServer();
    await server.listen();
    const page = await createPage('Gleichzeitig', 'Erster Absatz.\n');

    const ydoc = new Y.Doc();
    const provider = connect({ ticket: ticketFor(page, 'write'), name: page, document: ydoc });
    await waitFor(() => provider.isSynced);

    const typed = new Y.XmlElement('paragraph');
    typed.insert(0, [new Y.XmlText('Gerade getippt.')]);
    const fragment = ydoc.get(YJS_DOCUMENT_FIELD, Y.XmlFragment);
    fragment.insert(fragment.length, [typed]);

    const response = await applyContent({
      documentId: page,
      markdown: 'Vom Agenten angehängt.\n',
      mode: 'append',
    });
    expect(response.status).toBe(200);

    await waitFor(() => fragment.toJSON().includes('Vom Agenten angehängt.'));
    expect(fragment.toJSON()).toContain('Gerade getippt.');

    const persisted = await storedText(page);
    expect(persisted).toContain('Erster Absatz.');
    expect(persisted).toContain('Gerade getippt.');
    expect(persisted).toContain('Vom Agenten angehängt.');

    provider.destroy();
    ydoc.destroy();
    await server.destroy();
  }, 60_000);

  it('reports that nothing was applied when the page is not open here', async () => {
    const server = startServer();
    await server.listen();
    const page = await createPage('Niemand da', 'Unberührt.\n');

    const response = await applyContent({
      documentId: page,
      markdown: 'Darf hier nichts tun.\n',
      mode: 'replace',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ applied: false, clientsCount: 0 });

    // The caller's own database write is the whole truth in this case, so the
    // stored state must be exactly what it was.
    expect(await storedText(page)).toBe('Unberührt.');

    await server.destroy();
  }, 60_000);

  it('rejects a token that was not minted for this purpose', async () => {
    const server = startServer();
    await server.listen();
    const page = await createPage('Falscher Zweck', 'Bleibt.\n');

    const wrongPurpose = issueServiceToken({
      secret: TICKET_SECRET,
      userId,
      purpose: 'ai-tools',
      ttlSeconds: 60,
    }).token;

    const response = await applyContent({
      documentId: page,
      markdown: 'Darf nicht durchkommen.\n',
      mode: 'replace',
      token: wrongPurpose,
    });
    expect(response.status).toBe(401);
    expect(await storedText(page)).toBe('Bleibt.');

    await server.destroy();
  }, 60_000);

  it('refuses to write to an archived page even with a valid token', async () => {
    const server = startServer();
    await server.listen();
    const page = await createPage('Archiviert', 'Unveränderlich.\n', true);

    const ydoc = new Y.Doc();
    const provider = connect({ ticket: ticketFor(page, 'write'), name: page, document: ydoc });
    await waitFor(() => provider.isSynced);

    const response = await applyContent({
      documentId: page,
      markdown: 'Darf nicht landen.\n',
      mode: 'replace',
    });
    expect(response.status).toBe(403);
    expect(ydoc.get(YJS_DOCUMENT_FIELD, Y.XmlFragment).toJSON()).not.toContain(
      'Darf nicht landen.',
    );

    provider.destroy();
    ydoc.destroy();
    await server.destroy();
  }, 60_000);
});
