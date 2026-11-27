import { type PrismaClient, type PrismaTransactionClient } from './client';

/**
 * Files in a FILES column of a database row (issue #245).
 *
 * A FILES value is a list of attachment ids. A file uploaded into a cell hangs
 * on the row's page (`Attachment.documentId`), so it ends with the row like any
 * of the page's files, and carries `Attachment.propertyId`, which says it
 * belongs to the cell rather than to the page's text. The helpers here are the
 * two writes that tie the two together, shared by the API's upload path and
 * the worker's sweep so they cannot disagree about what "named by a cell"
 * means.
 */

/** The column a row's upload goes into, when it is one. */
export interface FilesTarget {
  /** The database (`COLLECTION`) the row belongs to. */
  collectionDocumentId: string;
}

/**
 * Whether `propertyId` is a FILES column of the database `rowId` is a row of
 * (ADR-011). `null` for anything else: a plain page, a column of another
 * database, a column of another type.
 */
export async function resolveFilesTarget(
  prisma: PrismaClient | PrismaTransactionClient,
  input: { rowId: string; propertyId: string },
): Promise<FilesTarget | null> {
  const row = await prisma.document.findUnique({
    where: { id: input.rowId },
    select: { type: true, parent: { select: { id: true, type: true } } },
  });
  if (row === null || row.type !== 'PAGE' || row.parent?.type !== 'COLLECTION') return null;
  const property = await prisma.databaseProperty.findUnique({
    where: { id: input.propertyId },
    select: { documentId: true, type: true },
  });
  if (property === null || property.documentId !== row.parent.id || property.type !== 'FILES') {
    return null;
  }
  return { collectionDocumentId: row.parent.id };
}

/**
 * Appends one file to a row's FILES value, inside the caller's transaction.
 *
 * Read and write under a transaction-scoped advisory lock on the cell, so two
 * files dropped at once both arrive instead of the second overwriting the
 * first; the lock ends with the transaction. An id already in the list is not
 * added twice.
 */
export async function appendPropertyFile(
  tx: PrismaTransactionClient,
  input: { rowId: string; propertyId: string; attachmentId: string },
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`files:${input.rowId}:${input.propertyId}`}))`;
  const current = await tx.documentPropertyValue.findUnique({
    where: { documentId_propertyId: { documentId: input.rowId, propertyId: input.propertyId } },
    select: { jsonValue: true },
  });
  const ids = Array.isArray(current?.jsonValue)
    ? current.jsonValue.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (ids.includes(input.attachmentId)) return;
  const next = [...ids, input.attachmentId];
  await tx.documentPropertyValue.upsert({
    where: { documentId_propertyId: { documentId: input.rowId, propertyId: input.propertyId } },
    create: { documentId: input.rowId, propertyId: input.propertyId, jsonValue: next },
    update: { jsonValue: next },
  });
}

/**
 * Files uploaded into a cell that no value of their column names any more,
 * and that are older than `before`: removed from the cell, left behind by a
 * deleted column or a column that changed its type, or uploaded by a request
 * whose value write never happened.
 *
 * "Any value of the column", not only the row the file hangs on: a row made
 * from a template copies its values (ADR-039) and so names the template's
 * files, and those must not vanish while the copy still shows them.
 */
export async function findUnreferencedPropertyFiles(
  prisma: PrismaClient,
  input: { before: Date; workspaceId: string | null; limit: number },
): Promise<{ id: string; storageKey: string; previewKey: string | null }[]> {
  return prisma.$queryRaw<{ id: string; storageKey: string; previewKey: string | null }[]>`
    SELECT a."id", a."storageKey", a."previewKey"
    FROM "attachment" a
    WHERE a."propertyId" IS NOT NULL
      AND a."deletedAt" IS NULL
      AND a."createdAt" < ${input.before}
      AND (${input.workspaceId}::text IS NULL OR a."workspaceId" = ${input.workspaceId})
      AND NOT EXISTS (
        SELECT 1
        FROM "document_property_value" v
        JOIN "database_property" p ON p."id" = v."propertyId"
        WHERE v."propertyId" = a."propertyId"
          AND p."type" = 'FILES'
          AND jsonb_typeof(v."jsonValue") = 'array'
          AND v."jsonValue" @> jsonb_build_array(a."id")
      )
    ORDER BY a."createdAt"
    LIMIT ${input.limit}
  `;
}
