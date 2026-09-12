import { type EntityRescanJob, type QUEUE_NAMES, type Settings } from '@exocortex/contracts';
import { loadEntityRegistry, type PrismaClient, replaceEntityMentions } from '@exocortex/database';
import { matchEntityAliases, sentenceAround } from '@exocortex/editor';
import { type JobContext } from '@exocortex/queue';

import { invalidateEntityRegistryCache } from './entity-extraction';

/**
 * Looks for one entity's names in pages that already exist (issue #47).
 *
 * The materialization pass only ever sees the page being saved, so an entity
 * created today would be invisible on every page written before it -- which is
 * all of them, on the day the layer is switched on. This is the other
 * direction: one name, every page.
 *
 * Not a full re-extraction of those pages. It writes the edge for *this* entity
 * and leaves every other edge on the page alone, because the pass that wrote
 * them looked at the whole text and this one has only looked for one name.
 */

/** Pages one rescan will look at. A ceiling, not a target. */
const MAX_DOCUMENTS = 2_000;

export interface EntityRescanDependencies {
  prisma: PrismaClient;
  settings: (workspaceId?: string) => Promise<Settings>;
}

export function createEntityRescanProcessor(dependencies: EntityRescanDependencies) {
  const { prisma, settings } = dependencies;

  return async ({
    payload,
    logger,
  }: JobContext<typeof QUEUE_NAMES.entityRescan>): Promise<void> => {
    const job: EntityRescanJob = payload;
    const current = await settings();
    if (!current['entities.enabled']) {
      logger.info('Entity rescan skipped: the layer is switched off', {
        entityDocumentId: job.entityDocumentId,
      });
      return;
    }

    // The aliases changed, which is usually why this job exists. The cached
    // registry in the extraction pass is now wrong for up to half a minute.
    invalidateEntityRegistryCache();

    // The database is the row's parent, not `entities.databaseId`.
    //
    // Not a shortcut: settings are cached for fifteen seconds here, and the very
    // first entity somebody creates is created seconds after the database was
    // provisioned and the setting written. Reading the setting made that first
    // rescan -- the one covering every page that already exists -- silently do
    // nothing. The row knows which database it is in without asking anybody.
    const row = await prisma.document.findUnique({
      where: { id: job.entityDocumentId },
      select: { parentId: true, archivedAt: true },
    });
    if (row === null || row.parentId === null || row.archivedAt !== null) {
      logger.warn('Entity rescan skipped: the entity is gone', {
        entityDocumentId: job.entityDocumentId,
      });
      return;
    }
    const databaseId = row.parentId;

    const entity = (await loadEntityRegistry(prisma, databaseId)).find(
      (record) => record.id === job.entityDocumentId,
    );
    if (entity === undefined) {
      logger.warn('Entity rescan skipped: the entity is gone', {
        entityDocumentId: job.entityDocumentId,
      });
      return;
    }

    const names = [entity.title, ...entity.aliases].filter(
      (name) => name.length >= current['entities.minAliasLength'],
    );
    if (names.length === 0) {
      logger.info('Entity rescan skipped: every name is shorter than the minimum', {
        entityDocumentId: job.entityDocumentId,
      });
      return;
    }

    // Narrowed in the database first, verified in JavaScript after: `contains`
    // has no idea what a word boundary is, so it answers with every page where
    // the name sits inside a longer one. It is a cheap way to not read the
    // whole deployment, not the match itself.
    const rows = await prisma.documentContent.findMany({
      where: {
        document: { archivedAt: null },
        documentId: { not: job.entityDocumentId },
        OR: names.map((name) => ({
          plainText: { contains: name, mode: 'insensitive' as const },
        })),
      },
      take: MAX_DOCUMENTS,
      select: {
        documentId: true,
        plainText: true,
        document: { select: { workspaceId: true } },
      },
    });

    const candidates = names.map((alias) => ({ entityId: entity.id, alias }));
    let linked = 0;
    for (const row of rows) {
      const text = row.plainText ?? '';
      const match = matchEntityAliases(text, candidates, {
        minAliasLength: current['entities.minAliasLength'],
      })[0];
      if (match === undefined) continue;

      await replaceEntityMentions(prisma, {
        documentId: row.documentId,
        workspaceId: row.document.workspaceId,
        // Only this entity's edge, and only as an addition: `replaceEntityMentions`
        // deletes the extracted edges *not* named, so the page's other entities
        // have to be named too or the rescan would wipe them.
        mentions: await keepExisting(prisma, row.documentId, {
          entityDocumentId: entity.id,
          alias: match.alias,
          aliasKey: match.aliasKey,
          occurrences: match.occurrences,
          context: match.context.length > 0 ? match.context : sentenceAround(text, 0),
        }),
      });
      linked += 1;
    }

    logger.info('Entity rescan finished', {
      entityDocumentId: entity.id,
      title: entity.title,
      reason: job.reason,
      scanned: rows.length,
      linked,
      truncated: rows.length >= MAX_DOCUMENTS,
    });
  };
}

/**
 * The page's existing extracted edges, with the new one merged in.
 *
 * `replaceEntityMentions` is wholesale by design, which is right for the
 * materialization pass and wrong here: this job has looked for one name and
 * knows nothing about the others. Reading them back and passing them along is
 * how one writer stays the only writer.
 */
async function keepExisting(
  prisma: PrismaClient,
  documentId: string,
  addition: {
    entityDocumentId: string;
    alias: string;
    aliasKey: string;
    occurrences: number;
    context: string;
  },
): Promise<
  {
    entityDocumentId: string;
    alias: string;
    aliasKey: string;
    occurrences: number;
    context: string;
  }[]
> {
  const existing = await prisma.entityMention.findMany({
    where: { documentId, source: 'EXTRACTED' },
    select: {
      entityDocumentId: true,
      alias: true,
      aliasKey: true,
      occurrences: true,
      context: true,
    },
  });
  return [
    ...existing.filter((mention) => mention.entityDocumentId !== addition.entityDocumentId),
    addition,
  ];
}
