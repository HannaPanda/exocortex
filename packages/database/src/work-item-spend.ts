import { Prisma, type PrismaClient } from './client';

/**
 * What the runs of one piece of work and of everything delegated below it
 * cost (issue #144, ADR-072), measured where known and estimated otherwise.
 *
 * Shared by the API, which holds a work item's budget against it, and the
 * worker, which counts an agent node's work against its workflow run's
 * budget (issue #162), so the two can never disagree about what was spent.
 */
export async function workItemSubtreeSpend(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  rootId: string,
): Promise<number> {
  // `UNION`, not `UNION ALL`: a cycle the API failed to refuse ends here
  // instead of recursing until the statement times out.
  const rows = await prisma.$queryRaw<{ spent: bigint | null }[]>(Prisma.sql`
    WITH RECURSIVE tree AS (
      SELECT id FROM work_item WHERE id = ${rootId}
      UNION
      SELECT child.id FROM work_item child JOIN tree ON child."parentId" = tree.id
    )
    SELECT COALESCE(SUM(COALESCE(run."providerCostMicroUsd", run."estimatedCostMicroUsd", 0)), 0)
      AS spent
    FROM ai_run run
    WHERE run."workItemId" IN (SELECT id FROM tree)
  `);
  return Number(rows[0]?.spent ?? 0);
}
