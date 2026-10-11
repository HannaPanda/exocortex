import {
  type PrismaClient,
  type PrismaTransactionClient,
  type WorkItemRefRole,
} from '@exocortex/database';

import { AppError } from '../common/app-error';

/**
 * Where a work item may point (issue #138): its parent and the pages it was
 * given or made. Each check answers for the workspace the item lives in,
 * because neither a parent nor a page reference can be a foreign key's job.
 */

/** Deep enough for any real hierarchy, short enough that a corrupt loop ends. */
const MAX_PARENT_DEPTH = 64;

/**
 * Same workspace, not the item itself, not below it.
 *
 * Walked upwards from the candidate: if the walk meets the item, the item
 * would become its own ancestor.
 */
export async function validateParent(
  prisma: PrismaClient,
  workspaceId: string,
  workItemId: string | null,
  parentId: string,
): Promise<void> {
  let cursor: string | null = parentId;
  for (let depth = 0; cursor !== null && depth < MAX_PARENT_DEPTH; depth += 1) {
    if (cursor === workItemId) {
      throw new AppError('work_item_parent_invalid', 'The parent would create a cycle');
    }
    const current: { workspaceId: string; parentId: string | null } | null =
      await prisma.workItem.findUnique({
        where: { id: cursor },
        select: { workspaceId: true, parentId: true },
      });
    if (current === null || current.workspaceId !== workspaceId) {
      throw new AppError('work_item_parent_invalid', 'The parent is not in this workspace');
    }
    cursor = current.parentId;
  }
}

/** Pages of this workspace only; `undefined` means the list is not being changed. */
export async function validateRefs(
  prisma: PrismaClient,
  workspaceId: string,
  documentIds: readonly string[] | undefined,
): Promise<string[] | undefined> {
  if (documentIds === undefined) return undefined;
  const unique = [...new Set(documentIds)];
  if (unique.length === 0) return [];
  const found = await prisma.document.count({
    where: { id: { in: unique }, workspaceId },
  });
  if (found !== unique.length) {
    throw new AppError('work_item_ref_invalid', 'A referenced page is not in this workspace');
  }
  return unique;
}

export async function replaceRefs(
  tx: PrismaTransactionClient,
  workItemId: string,
  role: WorkItemRefRole,
  documentIds: readonly string[],
): Promise<void> {
  await tx.workItemRef.deleteMany({ where: { workItemId, role } });
  if (documentIds.length === 0) return;
  await tx.workItemRef.createMany({
    data: documentIds.map((documentId) => ({ workItemId, documentId, role })),
  });
}
