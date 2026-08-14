import {
  generateOrderKey,
  initialOrderKey,
  type PrismaClient,
  type PrismaTransactionClient,
} from '@exocortex/database';

/**
 * Where a page sits among its siblings.
 *
 * Fractional keys rather than an integer position: inserting between two pages
 * has to be one write, not a renumbering of everything after it. Shared by
 * creating, updating and moving, which all have to agree on what "after this
 * one" means.
 */
export async function resolveOrderKey(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    parentId: string | null;
    afterSiblingId: string | null;
    beforeSiblingId: string | null;
    excludeDocumentId?: string;
    tx?: PrismaTransactionClient;
  },
): Promise<string> {
  const client = input.tx ?? prisma;
  const siblings = await client.document.findMany({
    where: {
      workspaceId: input.workspaceId,
      parentId: input.parentId,
      ...(input.excludeDocumentId === undefined ? {} : { id: { not: input.excludeDocumentId } }),
    },
    select: { id: true, orderKey: true },
    orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
  });

  if (siblings.length === 0) return initialOrderKey();

  const indexOf = (id: string | null): number =>
    id === null ? -1 : siblings.findIndex((sibling) => sibling.id === id);

  const afterIndex = indexOf(input.afterSiblingId);
  const beforeIndex = indexOf(input.beforeSiblingId);

  if (afterIndex >= 0) {
    const lower = siblings[afterIndex]?.orderKey ?? null;
    const upper = siblings[afterIndex + 1]?.orderKey ?? null;
    return generateOrderKey(lower, upper);
  }
  if (beforeIndex >= 0) {
    const upper = siblings[beforeIndex]?.orderKey ?? null;
    const lower = beforeIndex > 0 ? (siblings[beforeIndex - 1]?.orderKey ?? null) : null;
    return generateOrderKey(lower, upper);
  }

  // Default: append at the end.
  return generateOrderKey(siblings[siblings.length - 1]?.orderKey ?? null, null);
}
