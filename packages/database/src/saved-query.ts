import {
  type SavedQueryDateRange,
  type SavedQueryDefinition,
  type SavedQuerySort,
} from '@exocortex/contracts';

import { Prisma, type PrismaClient } from './client';
import { type DatabaseQueryScope } from './database-derived';
import { compileFilterGroup } from './database-query';
import { type SearchAdapter, type SearchHit } from './search';

/**
 * Running a saved query (issue #74).
 *
 * A query has two halves that cannot be answered by the same thing. The words
 * are answered by the search adapter, which knows about `tsvector`s and
 * vectors and ranking and nothing about the document tree; everything else is
 * answered by SQL over `document`, which knows about the tree and the property
 * values and nothing about relevance. So the two run one after the other:
 *
 *  * with a text, the adapter proposes candidates and SQL decides which of
 *    them survive the structural half,
 *  * without one, SQL alone answers, ordered and limited in the database.
 *
 * The other way round would mean handing the adapter a list of allowed ids,
 * which neither `PostgresSearchAdapter` nor a future OpenSearch takes, and
 * which a vector index could not use anyway.
 *
 * Nothing in here decides who may read what. The caller has already verified
 * membership; the workspace is part of every statement, which is what keeps a
 * result from crossing into another one.
 */

/** One hit, with the two dates a list view sorts by. */
export interface SavedQueryRow {
  documentId: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  iconColor: string | null;
  type: 'PAGE' | 'COLLECTION' | 'PROJECT';
  snippet: string;
  rank: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SavedQueryRunResult {
  rows: SavedQueryRow[];
  /** The limit cut the answer short, or the candidate list was capped. */
  truncated: boolean;
  /** Which adapter answered the text half; `none` when there was no text. */
  adapter: string;
}

export interface SavedQueryRunDeps {
  prisma: PrismaClient;
  /** Full text fused with meaning. Answers `textMode: 'HYBRID'`. */
  hybrid: SearchAdapter;
  /** Full text alone. Answers `textMode: 'KEYWORD'` and costs no model call. */
  keyword: SearchAdapter;
  /**
   * The schema of `definition.collectionId`, loaded by the caller with
   * `loadDatabaseScope`. Required exactly when the definition carries a
   * `propertyFilter`, because a property id means nothing without it.
   */
  scope?: DatabaseQueryScope;
}

export interface SavedQueryRunInput {
  workspaceId: string;
  definition: SavedQueryDefinition;
  /** Overrides `definition.limit`, for a block that shows five of them. */
  limit?: number;
  /** Injected so a relative window is testable. Defaults to the wall clock. */
  now?: Date;
}

export class SavedQueryScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SavedQueryScopeError';
  }
}

/**
 * How many candidates the adapter is asked for before the structural half
 * thins them out.
 *
 * The two halves are independent: a query for "Steuer" under one section may
 * have to look past fifty hits elsewhere before it finds the five that are in
 * it. Six times the limit with a floor is generous enough for that and still
 * one bounded index scan. The ceiling is what keeps a limit of 200 from asking
 * for 1200 rows and a vector scan to match.
 */
function candidateLimit(limit: number): number {
  return Math.min(Math.max(limit * 6, 120), 400);
}

/** The lower and upper bound of a window, resolved against now. */
export function resolveDateRange(
  range: SavedQueryDateRange,
  now: Date,
): { from: Date | null; to: Date | null } {
  const from =
    range.withinDays !== null
      ? new Date(now.getTime() - range.withinDays * 24 * 60 * 60 * 1000)
      : range.after !== null
        ? new Date(range.after)
        : null;
  const to = range.before !== null ? new Date(range.before) : null;
  return { from, to };
}

/** The subtree of one page, the page itself included, as a scalar subquery. */
function subtreeCondition(workspaceId: string, rootId: string): Prisma.Sql {
  return Prisma.sql`document."id" IN (
    WITH RECURSIVE "subtree" AS (
      SELECT "id" FROM "document"
        WHERE "id" = ${rootId} AND "workspaceId" = ${workspaceId}
      UNION ALL
      SELECT child."id" FROM "document" AS child
        JOIN "subtree" ON child."parentId" = "subtree"."id"
    )
    SELECT "id" FROM "subtree"
  )`;
}

function entityCondition(entityIds: readonly string[], match: 'ANY' | 'ALL'): Prisma.Sql {
  const ids = Prisma.join(entityIds.map((id) => Prisma.sql`${id}`));
  if (match === 'ANY') {
    return Prisma.sql`EXISTS (
      SELECT 1 FROM "entity_mention" AS mention
      WHERE mention."documentId" = document."id"
        AND mention."entityDocumentId" IN (${ids})
    )`;
  }
  // Counted against the number of *distinct* entities asked for: a request
  // that names the same entity twice would otherwise set a target no page can
  // reach, because `entity_mention` holds one row per pair.
  return Prisma.sql`(
    SELECT count(DISTINCT mention."entityDocumentId") FROM "entity_mention" AS mention
    WHERE mention."documentId" = document."id"
      AND mention."entityDocumentId" IN (${ids})
  ) = ${new Set(entityIds).size}`;
}

/**
 * Everything but the words: the structural half of a query, as one SQL
 * predicate over the alias `document`.
 *
 * The alias is not incidental. `compileFilterGroup` writes `document."..."`
 * into the property conditions it builds, so the statement this predicate goes
 * into has to spell the table that way too.
 */
export function compileStructuralFilter(
  input: SavedQueryRunInput,
  scope: DatabaseQueryScope | undefined,
): Prisma.Sql {
  const { workspaceId, definition } = input;
  const now = input.now ?? new Date();
  const parts: Prisma.Sql[] = [Prisma.sql`document."workspaceId" = ${workspaceId}`];

  if (!definition.includeArchived) parts.push(Prisma.sql`document."archivedAt" IS NULL`);

  if (definition.types.length > 0) {
    const types = Prisma.join(definition.types.map((type) => Prisma.sql`${type}`));
    parts.push(Prisma.sql`document."type"::text IN (${types})`);
  }

  if (definition.underDocumentId !== null) {
    parts.push(subtreeCondition(workspaceId, definition.underDocumentId));
  }

  // A row of a database is an ordinary page directly under it (ADR-011).
  if (definition.collectionId !== null) {
    parts.push(Prisma.sql`document."parentId" = ${definition.collectionId}`);
  }

  if (definition.entityIds.length > 0) {
    parts.push(entityCondition(definition.entityIds, definition.entityMatch));
  }

  for (const [column, range] of [
    ['updatedAt', definition.updated],
    ['createdAt', definition.created],
  ] as const) {
    const { from, to } = resolveDateRange(range, now);
    const reference = Prisma.raw(`"${column}"`);
    if (from !== null) parts.push(Prisma.sql`document.${reference} >= ${from}`);
    if (to !== null) parts.push(Prisma.sql`document.${reference} < ${to}`);
  }

  if (definition.propertyFilter !== null) {
    if (scope === undefined) {
      throw new SavedQueryScopeError('A property filter needs the schema of its database');
    }
    parts.push(Prisma.sql`(${compileFilterGroup(definition.propertyFilter, scope)})`);
  }

  return Prisma.join(parts, ' AND ');
}

/**
 * The ORDER BY for a query the database orders itself.
 *
 * `RELEVANCE` never reaches here: without a text there is nothing to be
 * relevant to, so the caller has already turned it into "newest first". The
 * title collation is the database's, which is what makes `TITLE_ASC` agree
 * with what the sidebar shows.
 */
function orderBy(sort: SavedQuerySort): Prisma.Sql {
  switch (sort) {
    case 'UPDATED_ASC':
      return Prisma.sql`document."updatedAt" ASC`;
    case 'CREATED_DESC':
      return Prisma.sql`document."createdAt" DESC`;
    case 'CREATED_ASC':
      return Prisma.sql`document."createdAt" ASC`;
    case 'TITLE_ASC':
      return Prisma.sql`lower(document."title") ASC`;
    case 'TITLE_DESC':
      return Prisma.sql`lower(document."title") DESC`;
    case 'RELEVANCE':
    case 'UPDATED_DESC':
      return Prisma.sql`document."updatedAt" DESC`;
  }
}

interface DocumentRow {
  documentId: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  iconColor: string | null;
  type: 'PAGE' | 'COLLECTION' | 'PROJECT';
  snippet: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const DOCUMENT_COLUMNS = Prisma.sql`
  document."id"           AS "documentId",
  document."workspaceId"  AS "workspaceId",
  document."parentId"     AS "parentId",
  document."title"        AS "title",
  document."icon"         AS "icon",
  document."iconColor"    AS "iconColor",
  document."type"::text   AS "type",
  left(index."plainText", 220) AS "snippet",
  document."archivedAt"   AS "archivedAt",
  document."createdAt"    AS "createdAt",
  document."updatedAt"    AS "updatedAt"
`;

function toRow(row: DocumentRow, rank: number, snippet?: string): SavedQueryRow {
  return {
    documentId: row.documentId,
    workspaceId: row.workspaceId,
    parentId: row.parentId,
    title: row.title,
    icon: row.icon,
    iconColor: row.iconColor,
    type: row.type,
    snippet: (snippet ?? row.snippet ?? '').replace(/\s+/g, ' ').trim(),
    rank,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Orders rows the adapter ranked, when the reader asked for something other than relevance. */
function reorder(rows: SavedQueryRow[], sort: SavedQuerySort): SavedQueryRow[] {
  const byDate = (a: Date, b: Date): number => a.getTime() - b.getTime();
  switch (sort) {
    case 'RELEVANCE':
      return rows;
    case 'UPDATED_DESC':
      return [...rows].sort((a, b) => byDate(b.updatedAt, a.updatedAt));
    case 'UPDATED_ASC':
      return [...rows].sort((a, b) => byDate(a.updatedAt, b.updatedAt));
    case 'CREATED_DESC':
      return [...rows].sort((a, b) => byDate(b.createdAt, a.createdAt));
    case 'CREATED_ASC':
      return [...rows].sort((a, b) => byDate(a.createdAt, b.createdAt));
    case 'TITLE_ASC':
      return [...rows].sort((a, b) => a.title.localeCompare(b.title, 'de'));
    case 'TITLE_DESC':
      return [...rows].sort((a, b) => b.title.localeCompare(a.title, 'de'));
  }
}

export async function runSavedQuery(
  deps: SavedQueryRunDeps,
  input: SavedQueryRunInput,
): Promise<SavedQueryRunResult> {
  const definition = input.definition;
  const limit = input.limit ?? definition.limit;
  const structural = compileStructuralFilter(input, deps.scope);
  const text = definition.text === null ? '' : definition.text.trim();

  if (text.length === 0) {
    // One row more than asked for: that is how "there are more of these" is
    // known without a second COUNT over the same predicate.
    const rows = await deps.prisma.$queryRaw<DocumentRow[]>(Prisma.sql`
      SELECT ${DOCUMENT_COLUMNS}
      FROM "document" AS document
      LEFT JOIN "document_search_index" AS index ON index."documentId" = document."id"
      WHERE ${structural}
      ORDER BY ${orderBy(definition.sort)}
      LIMIT ${limit + 1}
    `);
    return {
      rows: rows.slice(0, limit).map((row) => toRow(row, 0)),
      truncated: rows.length > limit,
      adapter: 'none',
    };
  }

  const adapter = definition.textMode === 'KEYWORD' ? deps.keyword : deps.hybrid;
  const ceiling = candidateLimit(limit);
  const hits = await adapter.search({
    workspaceId: input.workspaceId,
    query: text,
    limit: ceiling,
    includeArchived: definition.includeArchived,
  });
  if (hits.length === 0) return { rows: [], truncated: false, adapter: adapter.id };

  const candidates = Prisma.join(hits.map((hit: SearchHit) => Prisma.sql`${hit.documentId}`));
  const rows = await deps.prisma.$queryRaw<DocumentRow[]>(Prisma.sql`
    SELECT ${DOCUMENT_COLUMNS}
    FROM "document" AS document
    LEFT JOIN "document_search_index" AS index ON index."documentId" = document."id"
    WHERE document."id" IN (${candidates})
      AND ${structural}
  `);

  const byId = new Map(rows.map((row) => [row.documentId, row]));
  // The adapter's order is the relevance order, and it is the order the hits
  // arrived in; the snippet comes from the adapter too, because only it knows
  // which fragment matched.
  const ranked: SavedQueryRow[] = [];
  for (const hit of hits) {
    const row = byId.get(hit.documentId);
    if (row === undefined) continue;
    ranked.push(toRow(row, hit.rank, hit.snippet));
  }

  const ordered = reorder(ranked, definition.sort);
  return {
    rows: ordered.slice(0, limit),
    // Either the limit cut the list, or the adapter itself stopped at its
    // ceiling and there may be matches it never proposed. Both mean the same
    // thing to a reader: this is not the whole answer.
    truncated: ordered.length > limit || hits.length >= ceiling,
    adapter: adapter.id,
  };
}
