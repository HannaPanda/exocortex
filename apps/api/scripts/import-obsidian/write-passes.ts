import { QUEUE_NAMES } from '@exocortex/contracts';
import { generateOrderKey, type PrismaClient } from '@exocortex/database';
import { createEmptyYjsState, EXOCORTEX_SCHEMA_VERSION } from '@exocortex/editor';
import { createCorrelationId } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import { collectFolderPaths, comparePath, type VaultNote } from './vault';

const MATERIALIZATION_CHUNK_SIZE = 50;
const MATERIALIZATION_CHUNK_PAUSE_MS = 100;

// ---------------------------------------------------------------------------
// Order keys: siblings must be created in sorted order, and an idempotent
// re-run must continue after whatever already exists rather than colliding.
// ---------------------------------------------------------------------------

/**
 * The next order key under `parentId`, continuing after whatever is already
 * there. Cached per parent so a run of 600 siblings is one query, not 600.
 */
export async function nextOrderKey(
  prisma: PrismaClient,
  workspaceId: string,
  parentId: string | null,
  cache: Map<string, string | null>,
): Promise<string> {
  const cacheKey = parentId ?? '__root__';
  if (!cache.has(cacheKey)) {
    const last = await prisma.document.findFirst({
      where: { workspaceId, parentId },
      orderBy: { orderKey: 'desc' },
      select: { orderKey: true },
    });
    cache.set(cacheKey, last?.orderKey ?? null);
  }
  const previous = cache.get(cacheKey) ?? null;
  const next = generateOrderKey(previous, null);
  cache.set(cacheKey, next);
  return next;
}

/** Keeps the cache in step when an existing sibling is reused rather than created. */
export function rememberExistingOrderKey(
  cache: Map<string, string | null>,
  parentId: string | null,
  orderKey: string,
): void {
  const cacheKey = parentId ?? '__root__';
  const current = cache.get(cacheKey) ?? null;
  if (current === null || comparePath(orderKey, current) > 0) cache.set(cacheKey, orderKey);
}

/** What every write pass needs to know about where it is writing. */
export interface ImportTarget {
  prisma: PrismaClient;
  workspaceId: string;
  userId: string;
  dryRun: boolean;
  orderKeyCache: Map<string, string | null>;
}

/**
 * Pass 3: one page per vault folder, shallowest first, so a note always finds
 * its parent already created.
 */
export async function createFolderPages(
  target: ImportTarget,
  notes: readonly VaultNote[],
): Promise<{ folderPageId: Map<string, string>; created: number; existing: number }> {
  const { prisma, workspaceId, userId, orderKeyCache } = target;
  const folderPageId = new Map<string, string>();
  let foldersCreated = 0;
  let foldersExisting = 0;

  for (const folderPath of collectFolderPaths(notes)) {
    const segments = folderPath.split('/');
    const title = segments[segments.length - 1] as string;
    const parentPath = segments.slice(0, -1).join('/');
    const parentId = parentPath.length > 0 ? (folderPageId.get(parentPath) ?? null) : null;

    const existing = await prisma.document.findFirst({
      where: { workspaceId, parentId, title, type: 'PAGE' },
      select: { id: true, orderKey: true },
    });

    if (existing !== null) {
      folderPageId.set(folderPath, existing.id);
      rememberExistingOrderKey(orderKeyCache, parentId, existing.orderKey);
      foldersExisting += 1;
      continue;
    }

    foldersCreated += 1;
    if (target.dryRun) {
      folderPageId.set(folderPath, `dry-run:folder:${folderPath}`);
      continue;
    }

    const orderKey = await nextOrderKey(prisma, workspaceId, parentId, orderKeyCache);
    const created = await prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          workspaceId,
          parentId,
          type: 'PAGE',
          title,
          icon: '\u{1F4C1}',
          orderKey,
          createdById: userId,
          updatedById: userId,
        },
        select: { id: true },
      });
      await tx.documentContent.create({
        data: {
          documentId: document.id,
          yjsState: Buffer.from(createEmptyYjsState()),
          schemaVersion: EXOCORTEX_SCHEMA_VERSION,
          materializedAt: new Date(),
        },
      });
      return document;
    });
    folderPageId.set(folderPath, created.id);
  }

  return { folderPageId, created: foldersCreated, existing: foldersExisting };
}

/**
 * Pass 4, phase A: note stub pages.
 *
 * Ids first, content later: a wikilink can only be rewritten once every note
 * it might point at already has one.
 */
export async function createNoteStubs(
  target: ImportTarget,
  notes: readonly VaultNote[],
  folderPageId: Map<string, string>,
  titleOf: Map<string, string>,
): Promise<{ notePageId: Map<string, string>; created: number }> {
  const { prisma, workspaceId, userId, orderKeyCache } = target;
  const notePageId = new Map<string, string>();
  let notesCreated = 0;

  for (const note of notes) {
    const parentPath = note.folders.join('/');
    const parentId = parentPath.length > 0 ? (folderPageId.get(parentPath) ?? null) : null;
    const title = titleOf.get(note.relativePath) as string;

    const existing = await prisma.document.findFirst({
      where: { workspaceId, parentId, title, type: 'PAGE' },
      select: { id: true, orderKey: true },
    });

    if (existing !== null) {
      notePageId.set(note.relativePath, existing.id);
      rememberExistingOrderKey(orderKeyCache, parentId, existing.orderKey);
      continue;
    }

    notesCreated += 1;
    if (target.dryRun) {
      notePageId.set(note.relativePath, `dry-run:note:${note.relativePath}`);
      continue;
    }

    const orderKey = await nextOrderKey(prisma, workspaceId, parentId, orderKeyCache);
    const created = await prisma.document.create({
      data: {
        workspaceId,
        parentId,
        type: 'PAGE',
        title,
        orderKey,
        createdById: userId,
        updatedById: userId,
      },
      select: { id: true },
    });
    notePageId.set(note.relativePath, created.id);
  }

  return { notePageId, created: notesCreated };
}

/**
 * Queues materialization for everything that was written, in batches.
 *
 * 609 jobs at once is a self-inflicted outage on an 8 GB host that is also
 * serving live traffic.
 */
export async function enqueueMaterialization(
  queues: QueueRegistry | null,
  workspaceId: string,
  documentIds: readonly string[],
): Promise<number> {
  if (queues === null) return 0;
  let enqueued = 0;
  for (let start = 0; start < documentIds.length; start += MATERIALIZATION_CHUNK_SIZE) {
    const chunk = documentIds.slice(start, start + MATERIALIZATION_CHUNK_SIZE);
    await Promise.all(
      chunk.map((documentId) =>
        queues.enqueue(QUEUE_NAMES.documentMaterialization, {
          correlationId: createCorrelationId(),
          documentId,
          workspaceId,
          yjsUpdatedAt: Date.now(),
          reason: 'import',
        }),
      ),
    );
    enqueued += chunk.length;
    if (start + MATERIALIZATION_CHUNK_SIZE < documentIds.length) {
      await new Promise((resolve) => setTimeout(resolve, MATERIALIZATION_CHUNK_PAUSE_MS));
    }
  }
  return enqueued;
}
