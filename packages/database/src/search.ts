import { type SearchResult } from '@exocortex/contracts';

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
}

/**
 * Search adapter boundary.
 *
 * Application services only ever talk to this interface, so OpenSearch (or any
 * other engine) can be added later without touching them. The schema already
 * contains `pgvector` columns for a future semantic adapter; no embeddings are
 * generated in this version.
 */
export interface SearchAdapter {
  /** Identifier reported in the API response, e.g. `postgres`. */
  readonly id: string;
  search(query: SearchQuery): Promise<SearchResult[]>;
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
  type: 'PAGE' | 'COLLECTION';
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

  async search(query: SearchQuery): Promise<SearchResult[]> {
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
