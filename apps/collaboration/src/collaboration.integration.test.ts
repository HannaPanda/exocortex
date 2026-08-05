import { HocuspocusProvider } from '@hocuspocus/provider';
import { type Server } from '@hocuspocus/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';

import { issueCollaborationTicket } from '@exocortex/auth';
import { loadCollaborationEnv } from '@exocortex/config';
import { createPrismaClient, generateOrderKey, type PrismaClient } from '@exocortex/database';
import { createEmptyYjsState, YJS_DOCUMENT_FIELD, yjsStateToProseMirrorJson } from '@exocortex/editor';
import { createLogger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { createCollaborationServer } from './server';

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
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
}

function startServer(): Server {
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
  });
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

function ticketFor(target: string, access: 'read' | 'write', ttlSeconds = 60, now?: number): string {
  return issueCollaborationTicket({
    secret: TICKET_SECRET,
    userId,
    documentId: target,
    access,
    ttlSeconds,
    ...(now === undefined ? {} : { now }),
  }).ticket;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  queues = new QueueRegistry({ redisUrl: env.REDIS_URL, logger });

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
    const providerA = connect({ ticket: ticketFor(documentId, 'write'), name: documentId, document: documentA });
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
    const providerB = connect({ ticket: ticketFor(documentId, 'write'), name: documentId, document: documentB });
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
