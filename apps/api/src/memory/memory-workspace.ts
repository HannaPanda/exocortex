import { type Prisma, type PrismaClient } from '@exocortex/database';

/**
 * Roles that make a workspace somebody's memory area.
 *
 * A GUEST is deliberately not one of them. Resolution here decides where
 * `remember` writes, and pointing an account at an area it may only read would
 * turn a configuration question into a permission error on every capture.
 */
const WRITING_ROLES: Prisma.EnumWorkspaceRoleFilter = { in: ['MEMBER', 'ADMIN', 'OWNER'] };

/**
 * The caller's own memory area (issue #52, ADR-023).
 *
 * Replaces the deployment-wide `memory.workspaceId`. `recall`, `remember` and
 * `capture` are handed a user and a project and never a workspace, so there
 * was no context a per-workspace setting could have been resolved against --
 * and a single pointer meant every account on the deployment shared one
 * memory. The flag sits on the workspace row instead, and this is the one
 * place that reads it.
 *
 * Several memory areas for one account are legal and resolve to the oldest
 * membership. Deterministic rather than rejected: the flag is a convenience an
 * administrator sets, and an account that ends up in two of them should get a
 * stable answer instead of an error it cannot act on.
 */
export async function memoryWorkspaceFor(
  prisma: PrismaClient,
  userId: string,
): Promise<string | null> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { userId, role: WRITING_ROLES, workspace: { isMemory: true, archivedAt: null } },
    orderBy: { createdAt: 'asc' },
    select: { workspaceId: true },
  });
  return membership?.workspaceId ?? null;
}

/**
 * The memory areas among a set of workspaces the caller may already read.
 *
 * The reading counterpart: an entity profile pulls facts from every memory it
 * has access to, not only from the one it would write into. Membership is the
 * caller's business here, which is why this takes ids rather than a user.
 */
export async function memoryWorkspacesAmong(
  prisma: PrismaClient,
  workspaceIds: readonly string[],
): Promise<string[]> {
  if (workspaceIds.length === 0) return [];
  const rows = await prisma.workspace.findMany({
    where: { id: { in: [...workspaceIds] }, isMemory: true, archivedAt: null },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
