import { type ContextStage } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { CHUNK_THRESHOLD_CHARS, chunkBlockId, isChunkBlockId } from './chunking';
import { Prisma, type PrismaClient } from './client';
import {
  fusePassages,
  keywordPassageList,
  keywordTokens,
  type KeywordPage,
  type PassageCandidate,
  type PassageSection,
  type RankedPassage,
} from './context-packing';
import { keywordMatchSql } from './search';
import { type EmbeddingClient, type SemanticOptions } from './semantic-search';

/**
 * Where one request may look: a workspace, and within it either everything
 * (`null`) or exactly these pages.
 *
 * The set comes from `WorkspaceAccessService.requireScopedRole` and is already
 * closed over the hierarchy. It is applied inside the SQL, before anything is
 * ranked, so a confined credential's answer is not even shaped by the pages it
 * may not see: a fused score is a position in a list, and a position computed
 * against invisible pages would say that they exist.
 */
export interface PassageScope {
  workspaceId: string;
  documentIds: readonly string[] | null;
}

export interface PassageSearchQuery {
  scopes: readonly PassageScope[];
  query: string;
  /** Pages the keyword half cuts into passages. */
  pageLimit: number;
  /** Passage rows the semantic half reads. */
  passageLimit: number;
}

export interface PassageSearchResult {
  /** Fused and ranked, protected exact matches first. */
  candidates: PassageCandidate[];
  stages: ContextStage[];
}

/**
 * The passage boundary of the context compiler (issue #110, ADR-061).
 *
 * `SearchAdapter.search` answers with pages and stays that way: the search box
 * wants one line per page, and ADR-034 folds a page's passages into its best
 * one on purpose. A compiler has to see them before that fold, because one
 * page can hold three separate relevant sections. Hence a port of its own
 * rather than a flag on the page search.
 */
export interface PassageSearchPort {
  searchPassages(query: PassageSearchQuery): Promise<PassageSearchResult>;
}

export interface PostgresPassageSearchOptions {
  prisma: PrismaClient;
  /** `null` answers from full-text alone. */
  embeddings: EmbeddingClient | null;
  /** Read per call, like the page search (ADR-013). `null` means off. */
  options: () => Promise<SemanticOptions | null>;
  logger: Logger;
}

interface KeywordRow {
  documentId: string;
  workspaceId: string;
  title: string;
  plainText: string;
  updatedAt: Date;
}

interface PassageRow {
  documentId: string;
  workspaceId: string;
  title: string;
  blockId: string | null;
  /** `null` when the page has no materialized content yet. */
  text: string | null;
  headingBlockId: string | null;
  headingPath: unknown;
  updatedAt: Date;
}

interface AnchorRow {
  documentId: string;
  blockId: string;
  chunkText: string | null;
  headingBlockId: string | null;
  headingPath: unknown;
}

/**
 * Longest plain text read for one keyword page. Beyond it the page is cut at
 * request time into more passages than any answer could carry; see
 * `KEYWORD_MAX_CHUNKS`.
 */
const KEYWORD_TEXT_CEILING = 600_000;

/**
 * Floor on the cosine similarity between the question and a passage.
 *
 * Every question has nearest neighbours, so without a floor the semantic half
 * always hands over a full list, and the packer would fill the budget with it.
 * Measured on this deployment on 2026-09-24 (`openai/text-embedding-3-small`,
 * 3277 vectors, five real questions): the passages a reader would call
 * relevant sat between 0.36 and 0.64, and the first ones held together by
 * nothing but being German prose about work ("T3 Gezielte Korrektur" for a
 * question about an apple cake) at 0.31. The same 0.35 `findRelated` uses for
 * pages turned out to be the line here too.
 */
export const SEMANTIC_PASSAGE_FLOOR = 0.35;

/**
 * Full-text and passage vectors, over any number of workspaces at once.
 *
 * One embedding call per request however many workspaces are asked, which is
 * why the scopes travel together rather than as one search per workspace.
 * Degrades like the page search: with semantic search off or failing, the
 * answer is the keyword passages alone and `stages` says so.
 */
export class PostgresPassageSearch implements PassageSearchPort {
  constructor(private readonly deps: PostgresPassageSearchOptions) {}

  async searchPassages(query: PassageSearchQuery): Promise<PassageSearchResult> {
    if (query.scopes.length === 0 || query.query.trim().length === 0) {
      return { candidates: [], stages: [] };
    }
    const tokens = keywordTokens(query.query);
    const keyword = keywordPassageList(await this.keywordPages(query), tokens);

    const semanticOptions = this.deps.embeddings === null ? null : await this.deps.options();
    if (semanticOptions === null) {
      return { candidates: fusePassages(keyword, [], 0), stages: ['keyword'] };
    }

    let semantic: RankedPassage[];
    try {
      semantic = await this.semanticPassages(query, semanticOptions);
    } catch (error) {
      this.deps.logger.warn('Semantic passage search failed, answering from full-text only', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return { candidates: fusePassages(keyword, [], 0), stages: ['keyword'] };
    }

    const candidates = fusePassages(keyword, semantic, semanticOptions.weight);
    await this.locateKeywordPassages(candidates, semanticOptions.model);
    return { candidates, stages: ['keyword', 'semantic'] };
  }

  private scopePredicate(scopes: readonly PassageScope[], column: Prisma.Sql): Prisma.Sql {
    const open = scopes
      .filter((scope) => scope.documentIds === null)
      .map((scope) => scope.workspaceId);
    const confined = scopes.flatMap((scope) => scope.documentIds ?? []);
    return Prisma.sql`(
      index."workspaceId" = ANY(${open}::text[])
      OR ${column} = ANY(${confined}::text[])
    )`;
  }

  /**
   * The pages the page search would find for these words, with the page's own
   * text.
   *
   * The page's own text, not the search projection: the projection carries the
   * text extracted from the page's attachments behind it (issue #101), and
   * that is foreign text in the sense of ADR-030. `exo_attachment_read_text`
   * hands it over behind the fence; this tool is not fenced, so it must never
   * return it. A page found only by words in its PDF therefore contributes
   * nothing here unless its title matched.
   */
  private async keywordPages(query: PassageSearchQuery): Promise<KeywordPage[]> {
    const match = keywordMatchSql(query.query);
    const rows = await this.deps.prisma.$queryRaw<KeywordRow[]>(Prisma.sql`
      SELECT
        index."documentId"                                             AS "documentId",
        index."workspaceId"                                            AS "workspaceId",
        document."title"                                               AS "title",
        left(COALESCE(content."plainText", ''), ${KEYWORD_TEXT_CEILING}) AS "plainText",
        index."updatedAt"                                              AS "updatedAt"
      FROM "document_search_index" AS index
      JOIN "document" AS document ON document."id" = index."documentId"
      LEFT JOIN "document_content" AS content ON content."documentId" = index."documentId"
      WHERE ${this.scopePredicate(query.scopes, Prisma.sql`index."documentId"`)}
        AND index."archivedAt" IS NULL
        AND ${match.predicate}
      ORDER BY ${match.rank} DESC, index."updatedAt" DESC, index."documentId"
      LIMIT ${query.pageLimit}
    `);
    return rows.map((row) => ({
      documentId: row.documentId,
      workspaceId: row.workspaceId,
      title: row.title,
      plainText: row.plainText,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /**
   * The nearest passage rows, not folded to one per page.
   *
   * A passage row is a passage. A whole-document row only counts for a page
   * short enough never to have been cut (ADR-034): there it *is* the one
   * passage, while on a long page it is the average of all of them and its
   * passages compete in its place.
   *
   * A passage is handed over only when its text stands on the page itself
   * right now. That keeps out the passages cut from attachment text (see
   * `keywordPages`), which were embedded from the same projection, and it
   * keeps out a passage the page has lost since it was embedded.
   */
  private async semanticPassages(
    query: PassageSearchQuery,
    semantic: SemanticOptions,
  ): Promise<RankedPassage[]> {
    const client = this.deps.embeddings;
    if (client === null) return [];
    const [vector] = await client.embed({
      texts: [query.query.slice(0, client.maxInputChars)],
      model: semantic.model,
      correlationId: 'context-compile',
    });
    if (vector === undefined || vector.length !== client.dimensions) return [];

    const literal = `[${vector.join(',')}]`;
    const rows = await this.deps.prisma.$queryRaw<PassageRow[]>(Prisma.sql`
      SELECT
        embedding."documentId"                           AS "documentId",
        index."workspaceId"                              AS "workspaceId",
        document."title"                                 AS "title",
        embedding."blockId"                              AS "blockId",
        CASE
          WHEN embedding."blockId" IS NULL THEN content."plainText"
          ELSE embedding."chunkText"
        END                                              AS "text",
        embedding."headingBlockId"                       AS "headingBlockId",
        embedding."headingPath"                          AS "headingPath",
        index."updatedAt"                                AS "updatedAt"
      FROM "document_embedding" AS embedding
      JOIN "document_search_index" AS index ON index."documentId" = embedding."documentId"
      JOIN "document" AS document ON document."id" = embedding."documentId"
      JOIN "document_content" AS content ON content."documentId" = embedding."documentId"
      WHERE ${this.scopePredicate(query.scopes, Prisma.sql`embedding."documentId"`)}
        AND embedding."model" = ${semantic.model}
        AND index."archivedAt" IS NULL
        AND 1 - (embedding."embedding" <=> ${literal}::vector) >= ${SEMANTIC_PASSAGE_FLOOR}
        AND (
          (embedding."blockId" IS NOT NULL AND strpos(content."plainText", embedding."chunkText") > 0)
          OR (embedding."blockId" IS NULL AND length(index."plainText") <= ${CHUNK_THRESHOLD_CHARS})
        )
      ORDER BY embedding."embedding" <=> ${literal}::vector
      LIMIT ${query.passageLimit}
    `);

    return rows.flatMap((row): RankedPassage[] => {
      const ordinal = ordinalOf(row.blockId);
      const text = (row.text ?? '').trim();
      if (ordinal === null || text.length === 0) return [];
      return [
        {
          documentId: row.documentId,
          workspaceId: row.workspaceId,
          title: row.title,
          updatedAt: row.updatedAt.toISOString(),
          ordinal,
          text,
          section: sectionOf(row.headingBlockId, row.headingPath),
          exact: false,
        },
      ];
    });
  }

  /**
   * The section of the passages only the keywords found.
   *
   * The keyword half cuts the page the way the embeddings did, so where a
   * passage vector with the same ordinal and the same text is stored, its
   * heading is this passage's heading. Compared by text as well as by position:
   * a page edited since it was embedded may have moved its boundaries, and a
   * heading borrowed from a different paragraph would be a wrong address.
   */
  private async locateKeywordPassages(
    candidates: PassageCandidate[],
    model: string,
  ): Promise<void> {
    const unlocated = candidates.filter(
      (candidate) => candidate.section === null && candidate.match === 'keyword',
    );
    if (unlocated.length === 0) return;
    const rows = await this.deps.prisma.$queryRaw<AnchorRow[]>(Prisma.sql`
      SELECT "documentId", "blockId", "chunkText", "headingBlockId", "headingPath"
      FROM "document_embedding"
      WHERE "model" = ${model}
        AND ("documentId", "blockId") IN (${Prisma.join(
          unlocated.map(
            (candidate) =>
              Prisma.sql`(${candidate.documentId}, ${chunkBlockId(candidate.ordinal)})`,
          ),
        )})
    `);
    const byKey = new Map(rows.map((row) => [`${row.documentId}#${row.blockId}`, row]));
    for (const candidate of unlocated) {
      const row = byKey.get(`${candidate.documentId}#${chunkBlockId(candidate.ordinal)}`);
      if (row === undefined || row.chunkText?.trim() !== candidate.text) continue;
      candidate.section = sectionOf(row.headingBlockId, row.headingPath);
    }
  }
}

/** The passage a stored row stands for: a chunk's ordinal, or 0 for a short page's whole row. */
function ordinalOf(blockId: string | null): number | null {
  if (blockId === null) return 0;
  if (!isChunkBlockId(blockId)) return null;
  const ordinal = Number.parseInt(blockId.slice(blockId.indexOf(':') + 1), 10);
  return Number.isInteger(ordinal) ? ordinal : null;
}

/** Same reading of the stored heading as on a page hit. */
function sectionOf(headingBlockId: string | null, headingPath: unknown): PassageSection {
  if (!Array.isArray(headingPath) || headingPath.length === 0) return null;
  return {
    blockId: headingBlockId ?? null,
    path: headingPath.filter((entry): entry is string => typeof entry === 'string'),
  };
}
