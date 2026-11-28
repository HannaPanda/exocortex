import { type SearchResult } from '@exocortex/contracts';

import { type PassageAnchor } from './chunking';
import { Prisma, type PrismaClient } from './client';
import { hitLocation, type LocatedRow, type StoredSearchBlockMap } from './search-block-map';

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
  /**
   * Whether the document is a row of a database (a page under a
   * `COLLECTION`, ADR-011). A row with nothing on it but its title gets no
   * vector (issue #221): a table of ten thousand meals would otherwise carry
   * ten thousand title-only vectors, 63 MB of them, for rows that full-text
   * search finds by title anyway. Absent means "not a row".
   */
  isDatabaseRow?: boolean;
  /**
   * Which block every stretch of `plainText` came from (issue #280), built by
   * `toStoredBlockMap`. Written with the text it indexes, so the two never
   * disagree. Absent means "not computed": the column is cleared, because a
   * map of the previous text would point at the wrong blocks, and the
   * backfill sweep comes back for it.
   */
  blockMap?: StoredSearchBlockMap;
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

interface SearchRow extends LocatedRow {
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
 * What makes a row of `document_search_index` a keyword match, and how well.
 *
 * Shared by the page search below and the passage search of the context
 * compiler (issue #110), so the two can never disagree about which pages the
 * words found: the compiler is meant to cut the same hits finer, not to be a
 * second search algorithm. Both fragments refer to the index table under the
 * alias `index`.
 */
export function keywordMatchSql(query: string): { predicate: Prisma.Sql; rank: Prisma.Sql } {
  const tsQuery = buildTsQuery(query);
  const like = `%${query.trim().toLowerCase()}%`;
  return {
    predicate: Prisma.sql`(
      (${tsQuery} <> '' AND index."searchVector" @@ to_tsquery('simple', ${tsQuery}))
      OR lower(index."title") LIKE ${like}
      OR similarity(lower(index."title"), lower(${query})) > 0.25
    )`,
    rank: Prisma.sql`(
      CASE
        WHEN ${tsQuery} = '' THEN 0
        ELSE ts_rank_cd(index."searchVector", to_tsquery('simple', ${tsQuery}))
      END
      + similarity(lower(index."title"), lower(${query})) * 0.5
    )`,
  };
}

/**
 * Markers `ts_headline` is asked to use instead of `<mark>`, `</mark>` and
 * ` ... ` (issue #280). Private-use characters cannot occur in a page's text
 * the way a literal `<mark>` can, so the first fragment with them stripped is
 * exactly a stretch of `plainText` and can be found in it again. They become
 * the usual markup before the snippet leaves the query.
 */
const HIT_START = '\uE000';
const HIT_STOP = '\uE001';
const FRAGMENT_BREAK = '\uE002';
const HEADLINE_OPTIONS = `StartSel="${HIT_START}", StopSel="${HIT_STOP}", FragmentDelimiter="${FRAGMENT_BREAK}", MaxFragments=2, MaxWords=18, MinWords=5`;

/**
 * The keyword search, with every hit located on its page.
 *
 * Ranking and filtering first, so the headline (the expensive part) is only
 * cut for the rows that are returned. The hit's offset is where the first
 * highlighted word of the first fragment stands in `plainText`, found by
 * searching for the fragment itself; the location is the last unit of the
 * block map starting at or before it (ADR-100). Snippet and location therefore
 * describe the same occurrence of the word, and a fragment that cannot be
 * found again locates nothing rather than something wrong.
 */
function keywordSearchSql(query: SearchQuery): Prisma.Sql {
  const tsQuery = buildTsQuery(query.query);
  const match = keywordMatchSql(query.query);
  return Prisma.sql`
    WITH ranked AS (
      SELECT
        index."documentId", index."workspaceId", document."title", document."icon",
        document."iconColor", document."type", index."plainText", index."blockMap",
        ${match.rank} AS "rank", index."archivedAt", index."updatedAt"
      FROM "document_search_index" AS index
      JOIN "document" AS document ON document."id" = index."documentId"
      WHERE index."workspaceId" = ${query.workspaceId}
        AND (${query.includeArchived} OR index."archivedAt" IS NULL)
        AND ${match.predicate}
      ORDER BY "rank" DESC, index."updatedAt" DESC
      LIMIT ${query.limit}
    ),
    headlined AS (
      SELECT ranked.*,
        CASE WHEN ${tsQuery} = '' THEN NULL ELSE
          ts_headline('simple', ranked."plainText", to_tsquery('simple', ${tsQuery}), ${HEADLINE_OPTIONS}::text)
        END AS "headline"
      FROM ranked
    ),
    positioned AS (
      SELECT headlined.*,
        CASE
          WHEN headlined."blockMap" IS NULL OR strpos(first."fragment", ${HIT_START}::text) = 0 THEN NULL
          ELSE nullif(strpos(headlined."plainText", translate(first."fragment", ${HIT_START}::text || ${HIT_STOP}::text, '')), 0)
            - 1 + length(split_part(first."fragment", ${HIT_START}::text, 1))
        END AS "matchOffset"
      FROM headlined
      CROSS JOIN LATERAL (SELECT split_part(headlined."headline", ${FRAGMENT_BREAK}::text, 1) AS "fragment") AS first
    )
    SELECT
      p."documentId", p."workspaceId", p."title", p."icon", p."iconColor", p."type",
      CASE WHEN p."headline" IS NULL THEN left(p."plainText", 200)
        ELSE replace(replace(replace(p."headline", ${HIT_START}::text, '<mark>'), ${HIT_STOP}::text, '</mark>'), ${FRAGMENT_BREAK}::text, ' ... ')
      END AS "snippet",
      p."rank", p."archivedAt", p."updatedAt",
      unit."blockId" AS "hitBlockId", unit."heading" AS "hitHeading", unit."attachment" AS "hitAttachment"
    FROM positioned AS p
    LEFT JOIN LATERAL (
      SELECT
        p."blockMap"->'b'->>(u.i::int - 1)                                   AS "blockId",
        p."blockMap"->'h'->((p."blockMap"->'s'->>(u.i::int - 1))::int)       AS "heading",
        p."blockMap"->'f'->((p."blockMap"->'a'->>(u.i::int - 1))::int)       AS "attachment"
      FROM jsonb_array_elements_text(p."blockMap"->'o') WITH ORDINALITY AS u(v, i)
      WHERE p."matchOffset" IS NOT NULL AND u.v::int <= p."matchOffset"
      ORDER BY u.i DESC
      LIMIT 1
    ) AS unit ON TRUE
    ORDER BY p."rank" DESC, p."updatedAt" DESC
  `;
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
    const rows = await this.prisma.$queryRaw<SearchRow[]>(keywordSearchSql(query));

    return rows.map((row) => ({
      documentId: row.documentId,
      workspaceId: row.workspaceId,
      title: row.title,
      icon: row.icon,
      iconColor: row.iconColor,
      type: row.type,
      snippet: row.snippet.replace(/\s+/g, ' ').trim(),
      // Where the first highlighted word of the snippet stands (issue #280,
      // ADR-100): its block, the heading above it, or the attachment it is
      // in. All three `null` for a title-only match or an unmapped page.
      ...hitLocation(row),
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
        blockMap: blockMapValue(input),
      },
      update: {
        workspaceId: input.workspaceId,
        title: input.title,
        plainText: input.plainText,
        archivedAt: input.archivedAt,
        blockMap: blockMapValue(input),
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

/** The column value: the map, or SQL `NULL` for "still owed". */
function blockMapValue(input: IndexDocumentInput): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return input.blockMap === undefined ? Prisma.DbNull : { ...input.blockMap };
}
