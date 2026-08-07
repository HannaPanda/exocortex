import {
  Prisma,
  type PrismaClient,
  type PrismaTransactionClient,
} from '@exocortex/database';
import {
  type DocumentLinkKind,
  documentLinkTitleKey,
  extractDocumentLinks,
  type ProseMirrorDocument,
} from '@exocortex/editor';

/** Contract kind (and the editor's) to the database enum. */
const KIND_TO_DB = {
  pageLink: 'PAGE_LINK',
  mention: 'MENTION',
  wikiMark: 'WIKI_MARK',
} as const satisfies Record<DocumentLinkKind, 'PAGE_LINK' | 'MENTION' | 'WIKI_MARK'>;

/**
 * The one expression that turns a page title into the key a reference is
 * compared against. It must produce the same value as `documentLinkTitleKey`
 * in `@exocortex/editor`, which is what writes `targetTitleKey`.
 */
const TITLE_KEY_SQL = Prisma.sql`lower(btrim(regexp_replace(d."title", '\s+', ' ', 'g')))`;

/**
 * Re-points every reference matched by `where` at the page that currently
 * carries its title, or at nothing when no page does.
 *
 * One correlated update rather than a link step and an unlink step: whichever
 * direction a title moved in, "the best page with this title, or NULL" is the
 * correct answer for every row in scope, so the statement is idempotent and
 * cannot leave half of a rename applied. The ordering mirrors
 * `DocumentsService.resolveLink`, so following a link in the editor and reading
 * the Verweise tab agree on which of several same-titled pages wins.
 */
async function repointLinks(
  client: PrismaClient | PrismaTransactionClient,
  where: Prisma.Sql,
): Promise<number> {
  return client.$executeRaw`
    UPDATE "document_link" l
    SET "targetDocumentId" = (
      SELECT d."id"
      FROM "document" d
      WHERE d."workspaceId" = l."workspaceId"
        AND ${TITLE_KEY_SQL} = l."targetTitleKey"
      ORDER BY (d."archivedAt" IS NOT NULL) ASC, d."updatedAt" DESC, d."id" ASC
      LIMIT 1
    )
    WHERE ${where}
  `;
}

/**
 * Narrows a stored `proseMirrorJson` column to a document.
 *
 * Structural only: the extractor reads `content`, `attrs` and `marks`
 * defensively and ignores whatever it does not recognize, so a full schema
 * check would only make the backfill fail on documents it can perfectly well
 * read. `null` means "not materialized yet", which the caller treats as
 * "nothing to extract".
 */
export function asProseMirrorDocument(value: unknown): ProseMirrorDocument | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as { type?: unknown };
  if (candidate.type !== 'doc') return null;
  return value as ProseMirrorDocument;
}

export interface ReplaceDocumentLinksInput {
  documentId: string;
  workspaceId: string;
  proseMirrorJson: ProseMirrorDocument;
  /** Written to `DocumentContent.linksIndexedAt`; usually the materialization timestamp. */
  indexedAt: Date;
}

/**
 * Rebuilds the reference rows of one source document.
 *
 * Delete plus insert in a single transaction, exactly like the search
 * projection: a reference removed from the text has to disappear from the
 * index, and merging cannot express a removal. The rows are inserted
 * unresolved and pointed at their targets by the same statement a rename uses,
 * so there is only one place that decides what a title resolves to.
 */
export async function replaceDocumentLinks(
  prisma: PrismaClient,
  input: ReplaceDocumentLinksInput,
): Promise<number> {
  const links = extractDocumentLinks(input.proseMirrorJson);

  await prisma.$transaction(async (tx) => {
    await tx.documentLink.deleteMany({ where: { sourceDocumentId: input.documentId } });
    if (links.length > 0) {
      await tx.documentLink.createMany({
        data: links.map((link) => ({
          workspaceId: input.workspaceId,
          sourceDocumentId: input.documentId,
          targetDocumentId: null,
          targetTitle: link.targetTitle,
          targetTitleKey: link.targetTitleKey,
          kind: KIND_TO_DB[link.kind],
          blockId: link.blockId,
          context: link.context,
          position: link.position,
        })),
      });
      await repointLinks(tx, Prisma.sql`l."sourceDocumentId" = ${input.documentId}`);
    }
    await tx.documentContent.update({
      where: { documentId: input.documentId },
      data: { linksIndexedAt: input.indexedAt },
    });
  });

  return links.length;
}

/**
 * Re-resolves every reference affected by a page appearing, being renamed or
 * changing workspace.
 *
 * The titles in play are read rather than carried in the job: the page's
 * current one, plus every title currently bound to the page. The second set is
 * exactly the set of stale bindings a rename leaves behind, and reading it from
 * the index means the caller does not have to know what the old title was, and
 * a binding left over from an earlier failure is repaired on the next pass too.
 *
 * Bounded on purpose: only rows whose `targetTitleKey` is one of those few keys
 * are touched, which is an index range, not a workspace-wide sweep.
 *
 * Returns `null` when the page no longer exists; the foreign key has already
 * turned its incoming references into unresolved ones in that case.
 */
export async function resolveDocumentLinks(
  prisma: PrismaClient,
  documentId: string,
): Promise<number | null> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true, workspaceId: true, title: true },
  });
  if (document === null) return null;

  // A page that changed workspace takes its outgoing references and its whole
  // subtree with it; `workspaceId` on the reference is denormalized, so it has
  // to be corrected before anything resolves against it (issue #13 moves pages
  // between workspaces, and it moves the descendants along). The `<>` in the
  // join makes this a no-op for every other reason this task runs.
  await prisma.$executeRaw`
    WITH RECURSIVE subtree AS (
      SELECT "id", "workspaceId" FROM "document" WHERE "id" = ${documentId}
      UNION ALL
      SELECT d."id", d."workspaceId"
      FROM "document" d
      JOIN subtree s ON d."parentId" = s."id"
    )
    UPDATE "document_link" l
    SET "workspaceId" = s."workspaceId"
    FROM subtree s
    WHERE l."sourceDocumentId" = s."id" AND l."workspaceId" <> s."workspaceId"
  `;

  const bound = await prisma.documentLink.findMany({
    where: { targetDocumentId: documentId },
    select: { targetTitleKey: true },
    distinct: ['targetTitleKey'],
  });

  const keys = [
    ...new Set([documentLinkTitleKey(document.title), ...bound.map((row) => row.targetTitleKey)]),
  ].filter((key) => key.length > 0);
  if (keys.length === 0) return 0;

  // The second disjunct is the same move seen from the other side: a reference
  // in the *old* workspace still points at the page and has to let go of it,
  // even though its own workspace is no longer the page's.
  return repointLinks(
    prisma,
    Prisma.sql`l."targetTitleKey" IN (${Prisma.join(keys)})
      AND (l."workspaceId" = ${document.workspaceId} OR l."targetDocumentId" = ${documentId})`,
  );
}
