import { stricterLimit } from '@exocortex/contracts';
import { Prisma, type PrismaClient } from '@exocortex/database';

/**
 * A budget over a whole piece of work, children included (issue #144,
 * ADR-072).
 *
 * Before delegation an item's budget was held against its own runs. A child
 * has runs of its own, so a parent that hands everything on would never touch
 * its budget at all. So a budget now holds for the item's subtree: what every
 * run below it cost counts against it, and a run anywhere is refused once any
 * item above it has spent what it was given. The ancestor that is tightest is
 * named, so a refusal says whose budget it was.
 */

/** Deep enough for any real hierarchy, short enough that a corrupt loop ends. */
const MAX_DEPTH = 64;

export interface BudgetStanding {
  subtreeSpentMicroUsd: number;
  budgetRemainingMicroUsd: number | null;
  budgetLimitedBy: { id: string; title: string } | null;
}

/** What the runs of this item and of everything below it cost. */
export async function subtreeSpend(prisma: PrismaClient, rootId: string): Promise<number> {
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

/** The item and its ancestors, nearest first. */
async function chainOf(prisma: PrismaClient, itemId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string; depth: number }[]>(Prisma.sql`
    WITH RECURSIVE chain AS (
      SELECT id, "parentId", 0 AS depth FROM work_item WHERE id = ${itemId}
      UNION
      SELECT parent.id, parent."parentId", chain.depth + 1
      FROM work_item parent JOIN chain ON parent.id = chain."parentId"
      WHERE chain.depth < ${MAX_DEPTH}
    )
    SELECT id, depth FROM chain ORDER BY depth
  `);
  return rows.map((row) => row.id);
}

/**
 * Where the budget stands for one item: its subtree's spend, and the
 * smallest remainder of its own budget and every ancestor's.
 *
 * Each budget is the stricter of the item's own and its profile's per-task
 * budget (issue #143), with the workspace's default profile for an item that
 * names none, exactly as the detail computes it.
 */
export async function budgetStanding(
  prisma: PrismaClient,
  itemId: string,
): Promise<BudgetStanding> {
  const chain = await chainOf(prisma, itemId);
  const rows = await prisma.workItem.findMany({
    where: { id: { in: chain } },
    select: {
      id: true,
      title: true,
      budgetMicroUsd: true,
      agentProfile: { select: { budgetMicroUsdPerTask: true } },
      workspace: {
        select: {
          agentProfiles: {
            where: { isDefault: true },
            select: { budgetMicroUsdPerTask: true },
            take: 1,
          },
        },
      },
    },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  let subtreeSpentMicroUsd = 0;
  let remaining: number | null = null;
  let limitedBy: { id: string; title: string } | null = null;
  for (const id of chain) {
    const row = byId.get(id);
    if (row === undefined) continue;
    const perTask =
      row.agentProfile?.budgetMicroUsdPerTask ??
      row.workspace.agentProfiles[0]?.budgetMicroUsdPerTask ??
      null;
    const budget = stricterLimit(row.budgetMicroUsd, perTask);
    // The item's own spend is needed whatever its budget; an ancestor's only
    // when it has one.
    if (id !== itemId && budget === null) continue;
    const spent = await subtreeSpend(prisma, id);
    if (id === itemId) subtreeSpentMicroUsd = spent;
    if (budget === null) continue;
    const left = budget - spent;
    if (remaining === null || left < remaining) {
      remaining = left;
      limitedBy = id === itemId ? null : { id: row.id, title: row.title };
    }
  }
  return {
    subtreeSpentMicroUsd,
    budgetRemainingMicroUsd: remaining,
    budgetLimitedBy: limitedBy,
  };
}
