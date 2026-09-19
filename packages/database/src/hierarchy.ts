import { Prisma, type PrismaClient } from './client';

/**
 * Walking the page hierarchy in SQL (issue #83, ADR-044).
 *
 * `tree.ts` next door does the same walking in memory, on a list the caller has
 * already loaded, and that is right wherever the caller needed the list anyway
 * -- the tree endpoint, a move, a breadcrumb inside a workspace somebody is a
 * member of.
 *
 * Authorization cannot use it. Deciding whether one page lies inside a shared
 * branch must not begin by reading every page of the workspace: it happens on
 * every request, it happens for callers who may see exactly one branch, and
 * loading the workspace to answer it would be both the slowest and the leakiest
 * way to ask. So these two walk in the database and return ids, nothing else.
 */

/** How deep a chain is followed before it is treated as corrupt data. */
const MAX_DEPTH = 64;

interface ChainRow {
  id: string;
  depth: number;
}

/**
 * The page itself followed by its ancestors, nearest first.
 *
 * Returns an empty array when the page does not exist, which callers read as
 * "no grant can apply": a chain that starts nowhere contains nothing.
 */
export async function loadAncestorChain(
  prisma: PrismaClient,
  documentId: string,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<ChainRow[]>(Prisma.sql`
    WITH RECURSIVE chain AS (
      SELECT "id", "parentId", 0 AS depth
      FROM "document"
      WHERE "id" = ${documentId}
      UNION ALL
      SELECT parent."id", parent."parentId", chain.depth + 1
      FROM "document" parent
      JOIN chain ON parent."id" = chain."parentId"
      WHERE chain.depth < ${MAX_DEPTH}
    )
    SELECT "id", depth FROM chain ORDER BY depth ASC
  `);
  return rows.map((row) => row.id);
}

/**
 * Every descendant of `rootIds`, the roots included.
 *
 * Used where a scoped caller asks a question about a set of pages rather than
 * about one -- a search, a tree, a list of hits -- so the filter can be a
 * single `IN` instead of a chain walk per candidate.
 */
export async function loadSubtreeIds(
  prisma: PrismaClient,
  rootIds: readonly string[],
): Promise<Set<string>> {
  if (rootIds.length === 0) return new Set<string>();
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH RECURSIVE subtree AS (
      SELECT "id", 0 AS depth
      FROM "document"
      WHERE "id" IN (${Prisma.join(rootIds)})
      UNION ALL
      SELECT child."id", subtree.depth + 1
      FROM "document" child
      JOIN subtree ON child."parentId" = subtree."id"
      WHERE subtree.depth < ${MAX_DEPTH}
    )
    SELECT DISTINCT "id" FROM subtree
  `);
  return new Set(rows.map((row) => row.id));
}
