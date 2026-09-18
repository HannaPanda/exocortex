import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { resolveSettings } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { yjsStateToProseMirrorJson } from '@exocortex/editor';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { type CollaborationBridgeService } from '../documents/collaboration-bridge.service';
import { DocumentContentService } from '../documents/document-content.service';
import { DocumentMoveService } from '../documents/document-move.service';
import { DocumentTrashService } from '../documents/document-trash.service';
import { DocumentsService } from '../documents/documents.service';
import { PageLinkIdentityService } from '../documents/page-link-identity.service';
import { type SettingsService } from '../platform/settings.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { TemplatesService } from './templates.service';

/**
 * Page templates against the real database (issue #79, ADR-039).
 *
 * What is worth testing here is the one thing that cannot be read off the
 * code: that a copy is genuinely detached. Same text, different block ids, and
 * editing one does not touch the other.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const correlationId = 'test-correlation';

let prisma: PrismaClient;
let queues: QueueRegistry;
let documents: DocumentsService;
let content: DocumentContentService;
let templates: TemplatesService;
let workspaceId: string;
let ownerId: string;

const realtime = { emit: async () => undefined } as unknown as RealtimeService;
const storage = { deleteObject: async () => undefined } as unknown as ObjectStorage;
const collaboration = {
  applyToLiveSession: async () => ({
    applied: false,
    clientsCount: 0,
    yjsUpdatedAt: null,
    reachable: true,
  }),
} as unknown as CollaborationBridgeService;

/**
 * The defaults, and nothing read from the database.
 *
 * A stub that answered for every workspace once archived real memory notes
 * in this deployment; this one cannot, because the only key it is asked for
 * is the time zone the title pattern is rendered in.
 */
const settings = {
  getForWorkspace: async () => resolveSettings({ rows: [] }),
} as unknown as SettingsService;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-templates'),
  });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  documents = new DocumentsService(
    prisma,
    queues,
    logger,
    storage,
    access,
    outbox,
    realtime,
    new DocumentTrashService(prisma, queues, logger, storage, access, outbox, realtime),
    new DocumentMoveService(prisma, queues, logger, access, outbox, realtime),
  );
  content = new DocumentContentService(
    prisma,
    queues,
    logger,
    access,
    outbox,
    realtime,
    collaboration,
    new PageLinkIdentityService(prisma),
  );
  templates = new TemplatesService(prisma, logger, access, documents, settings);

  const suffix = Date.now().toString(36);
  const owner = await prisma.user.create({
    data: { email: `tpl-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
  });
  ownerId = owner.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Templates ${suffix}`,
      slug: `templates-${suffix}`,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

async function createPage(title: string, parentId: string | null = null): Promise<string> {
  const page = await documents.create({
    workspaceId,
    userId: ownerId,
    request: { title, type: 'PAGE', parentId },
    correlationId,
  });
  return page.id;
}

async function makeTemplate(title: string, markdown: string): Promise<string> {
  const documentId = await createPage(title);
  await content.write({
    documentId,
    userId: ownerId,
    request: { markdown, mode: 'replace' },
    correlationId,
    source: 'api',
  });
  await templates.create({ workspaceId, userId: ownerId, request: { documentId } });
  return documentId;
}

function blockIdsOf(state: Uint8Array): string[] {
  const ids: string[] = [];
  const walk = (node: { attrs?: Record<string, unknown>; content?: unknown[] }): void => {
    const id = node.attrs?.blockId;
    if (typeof id === 'string') ids.push(id);
    for (const child of node.content ?? []) {
      walk(child as { attrs?: Record<string, unknown>; content?: unknown[] });
    }
  };
  walk(yjsStateToProseMirrorJson(state));
  return ids;
}

async function stateOf(documentId: string): Promise<Uint8Array> {
  const row = await prisma.documentContent.findUniqueOrThrow({
    where: { documentId },
    select: { yjsState: true },
  });
  return row.yjsState;
}

describe('marking a page as a template', () => {
  it('lists it for the workspace and leaves the page where it is', async () => {
    const documentId = await makeTemplate('Meeting-Notiz', '## Teilnehmende\n\n## Beschlüsse');

    const listed = await templates.list({ workspaceId, userId: ownerId });
    const entry = listed.templates.find((template) => template.document.id === documentId);
    expect(entry?.document.title).toBe('Meeting-Notiz');
    expect(entry?.useCount).toBe(0);

    const page = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(page.parentId).toBeNull();
    expect(page.type).toBe('PAGE');
  });

  it('refuses a database', async () => {
    const database = await documents.create({
      workspaceId,
      userId: ownerId,
      request: { title: 'Aufgaben', type: 'COLLECTION' },
      correlationId,
    });
    await expect(
      templates.create({ workspaceId, userId: ownerId, request: { documentId: database.id } }),
    ).rejects.toMatchObject({ code: 'template_not_a_page' });
  });

  it('refuses the same page twice', async () => {
    const documentId = await makeTemplate('Recherche', 'Frage:');
    await expect(
      templates.create({ workspaceId, userId: ownerId, request: { documentId } }),
    ).rejects.toMatchObject({ code: 'template_exists' });
  });

  it('keeps the page when the mark is removed', async () => {
    const documentId = await makeTemplate('Incident', '## Was ist passiert');
    await templates.remove({ documentId, userId: ownerId });

    const listed = await templates.list({ workspaceId, userId: ownerId });
    expect(listed.templates.some((template) => template.document.id === documentId)).toBe(false);
    await expect(
      prisma.document.findUniqueOrThrow({ where: { id: documentId } }),
    ).resolves.toMatchObject({ archivedAt: null });
  });
});

describe('using a template', () => {
  it('copies the content and detaches it', async () => {
    const templateId = await makeTemplate('Wochenreview', '## Gut gelaufen\n\n## Nächste Woche');

    const created = await templates.instantiate({
      documentId: templateId,
      userId: ownerId,
      request: {},
      correlationId,
    });

    const copyState = await stateOf(created.document.id);
    const templateState = await stateOf(templateId);

    // Same text.
    expect(JSON.stringify(yjsStateToProseMirrorJson(copyState))).toContain('Gut gelaufen');
    // Different addresses.
    const shared = blockIdsOf(copyState).filter((id) => blockIdsOf(templateState).includes(id));
    expect(shared).toEqual([]);

    // Writing to the copy leaves the template alone.
    await content.write({
      documentId: created.document.id,
      userId: ownerId,
      request: { markdown: 'Nur in der Kopie', mode: 'replace' },
      correlationId,
      source: 'api',
    });
    const templateAfter = JSON.stringify(yjsStateToProseMirrorJson(await stateOf(templateId)));
    expect(templateAfter).toContain('Gut gelaufen');
    expect(templateAfter).not.toContain('Nur in der Kopie');
  });

  it('builds the title from the pattern and counts the use', async () => {
    const templateId = await makeTemplate('Notiz', 'Text');
    await templates.update({
      documentId: templateId,
      userId: ownerId,
      request: { titlePattern: 'Notiz {{jahr}}' },
    });

    const created = await templates.instantiate({
      documentId: templateId,
      userId: ownerId,
      request: {},
      correlationId,
    });
    expect(created.document.title).toMatch(/^Notiz \d{4}$/);

    const listed = await templates.list({ workspaceId, userId: ownerId });
    const entry = listed.templates.find((template) => template.document.id === templateId);
    expect(entry?.useCount).toBe(1);
    expect(entry?.lastUsedAt).not.toBeNull();
  });

  it('lands under the suggested target and lets the caller overrule it', async () => {
    const home = await createPage('Reviews');
    const elsewhere = await createPage('Anderswo');
    const templateId = await makeTemplate('Review', 'Text');
    await templates.update({
      documentId: templateId,
      userId: ownerId,
      request: { targetParentId: home },
    });

    const defaulted = await templates.instantiate({
      documentId: templateId,
      userId: ownerId,
      request: {},
      correlationId,
    });
    expect(defaulted.parent?.id).toBe(home);

    const overruled = await templates.instantiate({
      documentId: templateId,
      userId: ownerId,
      request: { parentId: elsewhere },
      correlationId,
    });
    expect(overruled.parent?.id).toBe(elsewhere);

    const root = await templates.instantiate({
      documentId: templateId,
      userId: ownerId,
      request: { parentId: null },
      correlationId,
    });
    expect(root.parent).toBeNull();
  });

  it('carries row properties over inside the same database, and not outside it', async () => {
    const database = await documents.create({
      workspaceId,
      userId: ownerId,
      request: { title: 'Projekte', type: 'COLLECTION' },
      correlationId,
    });
    const property = await prisma.databaseProperty.create({
      data: {
        document: { connect: { id: database.id } },
        name: 'Status',
        type: 'TEXT',
        orderKey: 'a0',
      },
    });

    const templateId = await createPage('Projektvorlage', database.id);
    await prisma.documentPropertyValue.create({
      data: { documentId: templateId, propertyId: property.id, textValue: 'geplant' },
    });
    await templates.create({ workspaceId, userId: ownerId, request: { documentId: templateId } });

    const inside = await templates.instantiate({
      documentId: templateId,
      userId: ownerId,
      request: { parentId: database.id },
      correlationId,
    });
    expect(inside.copiedProperties).toBe(1);
    const copied = await prisma.documentPropertyValue.findFirstOrThrow({
      where: { documentId: inside.document.id },
    });
    expect(copied.textValue).toBe('geplant');

    const other = await documents.create({
      workspaceId,
      userId: ownerId,
      request: { title: 'Andere Datenbank', type: 'COLLECTION' },
      correlationId,
    });
    const outside = await templates.instantiate({
      documentId: templateId,
      userId: ownerId,
      request: { parentId: other.id },
      correlationId,
    });
    expect(outside.copiedProperties).toBe(0);
    expect(outside.warnings.join(' ')).toContain('andere');
  });

  it('refuses a template nobody marked', async () => {
    const documentId = await createPage('Gewöhnlich');
    await expect(
      templates.instantiate({ documentId, userId: ownerId, request: {}, correlationId }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
