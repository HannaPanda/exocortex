import { type SearchResult } from '@exocortex/contracts';

import { type PassageAnchor } from './chunking';
import { Prisma, type PrismaClient } from './client';

export interface SearchQuery {
  workspaceId: string;
  /** Raw user input; the adapter is responsible for sanitizing it. */
  query: string;
  limit: number;
  includeArchived: boolean;
}

export interface IndexDocumentInput {
  documentId: string;
  workspaceId: string;
  title: string;
  plainText: string;
  archivedAt: Date | null;
  /**
   * The headings of `plainText`, so the passages cut out of it can say which
   * section they came from (issue #118).
   *
   * Only the semantic half uses them, and only a caller holding the page's
   * structure can produce them. Absent means "not computed", which is a
   * different thing from a page that has no headings: the first is worth
   * coming back for, the second is not.
   */
  headingAnchors?: readonly PassageAnchor[];
}

/**
 * Search adapter boundary.
 *
 * Application services only ever talk to this interface, so OpenSearch (or any
 * other engine) can be added later without touching them. The semantic half
 * lives beside this one in `semantic-search.ts` (ADR-020) and wraps it.
 */
/**
 * What an adapter can answer on its own.
 *
 * `path` is deliberately not part of it: where a page sits is a property of the
 * document tree, not of the index, and an engine like OpenSearch would have no
 * way to know. The application service fills it in.
 */
export type SearchHit = Omit<SearchResult, 'path'>;

export interface SearchAdapter {
  /** Identifier reported in the API response, e.g. `postgres`. */
  readonly id: string;
  search(query: SearchQuery): Promise<SearchHit[]>;
  index(input: IndexDocumentInput): Promise<void>;
  remove(documentId: string): Promise<void>;
  healthCheck(): Promise<boolean>;
}

interface SearchRow {
  documentId: string;
  workspaceId: string;
  title: string;
  icon: string | null;
  iconColor: SearchResult['iconColor'];
  type: 'PAGE' | 'COLLECTION' | 'PROJECT';
  snippet: string;
  rank: number;
  archivedAt: Date | null;
  updatedAt: Date;
}

/**
 * Turns free user input into a `tsquery`.
 *
 * Every token is prefix-matched (`:*`) and combined with AND, which matches what
 * users expect from an incremental search box. Special characters are stripped so
 * a stray `&` or `!` cannot produce a syntax error.
 */
export function buildTsQuery(input: string): string {
  const tokens = input
    .toLowerCase()
    .split(/[^\p{Letter}\p{Number}_]+/u)
    .filter((token) => token.length > 0)
    .slice(0, 10);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `${token}:*`).join(' & ');
}

/**
 * PostgreSQL full-text search plus trigram-based tolerant title matching.
 *
 * Ranking combines:
 *  * `ts_rank_cd` over the weighted tsvector (title weight A, body weight B)
 *  * trigram similarity on the title, which survives typos
 *
 * Permission filtering happens in SQL: only documents of the given workspace are
 * ever considered, and the caller has already verified membership.
 */
export class PostgresSearchAdapter implements SearchAdapter {
  public readonly id = 'postgres';

  constructor(private readonly prisma: PrismaClient) {}

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const tsQuery = buildTsQuery(query.query);
    const like = `%${query.query.trim().toLowerCase()}%`;

    const rows = await this.prisma.$queryRaw<SearchRow[]>(Prisma.sql`
      SELECT
        index."documentId"                                             AS "documentId",
        index."workspaceId"                                            AS "workspaceId",
        document."title"                                               AS "title",
        document."icon"                                                AS "icon",
        document."iconColor"                                           AS "iconColor",
        document."type"                                                AS "type",
        CASE
          WHEN ${tsQuery} = '' THEN left(index."plainText", 200)
          ELSE ts_headline(
            'simple',
            index."plainText",
            to_tsquery('simple', ${tsQuery}),
            'StartSel=<mark>, StopSel=</mark>, MaxFragments=2, MaxWords=18, MinWords=5'
          )
        END                                                            AS "snippet",
        (
          CASE
            WHEN ${tsQuery} = '' THEN 0
            ELSE ts_rank_cd(index."searchVector", to_tsquery('simple', ${tsQuery}))
          END
          + similarity(lower(index."title"), lower(${query.query})) * 0.5
        )                                                              AS "rank",
        index."archivedAt"                                             AS "archivedAt",
        index."updatedAt"                                              AS "updatedAt"
      FROM "document_search_index" AS index
      JOIN "document" AS document ON document."id" = index."documentId"
      WHERE index."workspaceId" = ${query.workspaceId}
        AND (${query.includeArchived} OR index."archivedAt" IS NULL)
        AND (
          (${tsQuery} <> '' AND index."searchVector" @@ to_tsquery('simple', ${tsQuery}))
          OR lower(index."title") LIKE ${like}
          OR similarity(lower(index."title"), lower(${query.query})) > 0.25
        )
      ORDER BY "rank" DESC, index."updatedAt" DESC
      LIMIT ${query.limit}
    `);

    return rows.map((row) => ({
      documentId: row.documentId,
      workspaceId: row.workspaceId,
      title: row.title,
      icon: row.icon,
      iconColor: row.iconColor,
      type: row.type,
      snippet: row.snippet.replace(/\s+/g, ' ').trim(),
      // A keyword match is a position in a `tsvector`, and nothing maps that
      // position back onto a block: the offset-to-block table issue #110 needs
      // anyway does not exist yet, and guessing at one would be worse than
      // saying nothing. The semantic half does locate its hits, and fusion
      // keeps that when both halves found the same page.
      section: null,
      rank: Number(row.rank),
      archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /** Idempotent upsert of the search projection. */
  async index(input: IndexDocumentInput): Promise<void> {
    await this.prisma.documentSearchIndex.upsert({
      where: { documentId: input.documentId },
      create: {
        documentId: input.documentId,
        workspaceId: input.workspaceId,
        title: input.title,
        plainText: input.plainText,
        archivedAt: input.archivedAt,
      },
      update: {
        workspaceId: input.workspaceId,
        title: input.title,
        plainText: input.plainText,
        archivedAt: input.archivedAt,
      },
    });
  }

  async remove(documentId: string): Promise<void> {
    await this.prisma.documentSearchIndex.deleteMany({ where: { documentId } });
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
