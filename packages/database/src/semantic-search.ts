import { createHash } from 'node:crypto';

import { type Logger } from '@exocortex/logger';

import { Prisma, type PrismaClient } from './client';
import {
  type IndexDocumentInput,
  type SearchAdapter,
  type SearchHit,
  type SearchQuery,
} from './search';

/**
 * Semantic search over the `document_embedding` table (issue #34, AP4).
 *
 * Full-text search answers "I know roughly which word was in it". It cannot
 * answer "I only know what it was about", because a `tsvector` has no idea that
 * a note about `Termine` is the answer to a question about `Verabredungen`.
 * That second question is exactly what an agent's `recall` asks, which is why
 * this exists.
 *
 * The vectors are produced outside this package. `packages/database` must not
 * depend on `@exocortex/ai` (see `scripts/dependency-graph.mjs`), so the
 * embedding model reaches the adapter as the small port below, injected by
 * whichever composition root builds the adapter.
 */

export interface EmbeddingClient {
  /** Length of the vectors this client produces. Must match the column. */
  readonly dimensions: number;
  /** Longest text worth sending; the adapter truncates to it. */
  readonly maxInputChars: number;
  /** One vector per text, in the same order. */
  embed(input: {
    texts: readonly string[];
    model: string;
    correlationId: string;
  }): Promise<readonly (readonly number[])[]>;
}

export interface SemanticOptions {
  /** Model slug the vectors are written and read under. */
  model: string;
  /**
   * How much the semantic list counts against the full-text list, between 0 and
   * 1. `0.5` weighs them equally.
   */
  weight: number;
}

/**
 * Nearest neighbours pulled before fusion, relative to what the caller asked
 * for. Fusion can only reorder what it is given, so the vector list has to be
 * longer than the answer; four times with a floor is enough for a page that no
 * keyword matches to still climb into a short result list.
 */
function candidateCount(limit: number): number {
  return Math.max(limit * 4, 20);
}

/**
 * Rank-fusion constant. 60 is the value the original reciprocal-rank-fusion
 * paper uses and what OpenSearch and Elasticsearch default to: large enough
 * that the top few ranks of a list are close together, small enough that being
 * first still means something.
 */
const RRF_K = 60;

/** Hash of the text an embedding was built from, so an unchanged page is not re-embedded. */
export function embeddingTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** The text a document is embedded as: its title carries meaning the body may not repeat. */
export function embeddingInputFor(
  input: { title: string; plainText: string },
  maxChars: number,
): string {
  return `${input.title}\n\n${input.plainText}`.slice(0, maxChars).trim();
}

/**
 * pgvector wants `'[1,2,3]'`. Built as a bound parameter, never interpolated:
 * the numbers come from a provider response, and a string built by hand is how
 * an injection gets in.
 */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}

interface VectorRow {
  documentId: string;
  workspaceId: string;
  title: string;
  icon: string | null;
  iconColor: SearchHit['iconColor'];
  type: 'PAGE' | 'COLLECTION';
  snippet: string;
  similarity: number;
  archivedAt: Date | null;
  updatedAt: Date;
}

export interface RelatedQuery {
  documentId: string;
  workspaceId: string;
  limit: number;
  /**
   * Floor on cosine similarity. Without one the answer is always full: the
   * nearest neighbours of a page exist even when the whole workspace is about
   * something else, and a list of confident-looking unrelated pages is worse
   * than an empty one.
   */
  minSimilarity: number;
  includeArchived: boolean;
}

/**
 * `hits` carries `rank` as the cosine similarity, between 0 and 1.
 *
 * `state` says why the list can be empty. `pending` means this page has no
 * vector yet, which is a different sentence to a reader than "nothing
 * resembles it" and cannot be told apart from the list alone.
 */
export interface RelatedResult {
  state: 'ready' | 'pending' | 'disabled';
  hits: SearchHit[];
}

/**
 * The part of an adapter that can answer "what resembles this page".
 *
 * Kept separate from `SearchAdapter` because it is not something every engine
 * can do: it needs stored vectors. An adapter without them is not broken, it
 * simply never reports `ready`, and `supportsRelatedDocuments` is how a caller
 * finds out without knowing which class it holds.
 */
export interface RelatedDocumentsPort {
  findRelated(query: RelatedQuery): Promise<RelatedResult>;
}

export function supportsRelatedDocuments(
  adapter: SearchAdapter,
): adapter is SearchAdapter & RelatedDocumentsPort {
  return typeof (adapter as Partial<RelatedDocumentsPort>).findRelated === 'function';
}

export interface HybridSearchAdapterOptions {
  prisma: PrismaClient;
  /** The full-text half. Every call is delegated to it first. */
  keyword: SearchAdapter;
  /** `null` disables the semantic half for that call, without an error. */
  embeddings: EmbeddingClient | null;
  /**
   * Read per call, not per process: an admin turns semantic search on in the
   * running deployment (ADR-013). `null` means "off".
   */
  options: () => Promise<SemanticOptions | null>;
  logger: Logger;
}

/**
 * Full-text and vector search, fused.
 *
 * Degrades in one direction only. Whenever the semantic half is off,
 * unconfigured or broken, the answer is the plain full-text answer and the
 * search box keeps working; the reverse never happens, because a vector hit
 * without a keyword hit is still a real hit and is merged in.
 */
export class HybridSearchAdapter implements SearchAdapter, RelatedDocumentsPort {
  public readonly id = 'postgres+pgvector';

  constructor(private readonly deps: HybridSearchAdapterOptions) {}

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const keywordHits = await this.deps.keyword.search(query);
    const semantic = await this.resolveOptions();
    if (semantic === null || query.query.trim().length === 0) return keywordHits;

    let vectorHits: SearchHit[];
    try {
      vectorHits = await this.vectorSearch(query, semantic);
    } catch (error) {
      // A missing key, an exhausted account or a slow model must not take the
      // search box down with it. The keyword answer is a correct answer.
      this.deps.logger.warn('Semantic search failed, answering from full-text only', {
        workspaceId: query.workspaceId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return keywordHits;
    }

    return fuse(keywordHits, vectorHits, semantic.weight).slice(0, query.limit);
  }

  /**
   * Keeps both projections in sync.
   *
   * The full-text row is written first and its success is what the caller sees:
   * a document that could not be embedded is still findable, so an embedding
   * failure is logged and swallowed rather than failing the indexing job into a
   * retry loop. `backfill-embeddings` picks the page up later.
   */
  async index(input: IndexDocumentInput): Promise<void> {
    await this.deps.keyword.index(input);

    const semantic = await this.resolveOptions();
    if (semantic === null) return;

    try {
      await this.writeEmbedding(input, semantic.model);
    } catch (error) {
      this.deps.logger.warn('Could not embed a document', {
        documentId: input.documentId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async remove(documentId: string): Promise<void> {
    await this.deps.keyword.remove(documentId);
    await this.deps.prisma.$executeRaw`
      DELETE FROM "document_embedding" WHERE "documentId" = ${documentId}
    `;
  }

  async healthCheck(): Promise<boolean> {
    return this.deps.keyword.healthCheck();
  }

  /**
   * Writes the vector for one document, or does nothing when the text it would
   * be built from has not changed. Editing a page re-runs indexing on every
   * materialization, and paying a model for a vector that is already stored is
   * the one avoidable cost in this feature.
   *
   * Returns whether it called the model, which is what the backfill counts.
   */
  async writeEmbedding(input: IndexDocumentInput, model: string): Promise<boolean> {
    return (await this.writeEmbeddings([input], model)) > 0;
  }

  /**
   * The same for a batch, in one request to the model.
   *
   * What the backfill uses. One page per request spends its time waiting: a
   * round trip to the provider costs about as much for thirty texts as for one,
   * and a first fill of a workspace is thousands of pages. Returns how many
   * were actually embedded.
   */
  async writeEmbeddings(inputs: readonly IndexDocumentInput[], model: string): Promise<number> {
    const client = this.deps.embeddings;
    if (client === null || inputs.length === 0) return 0;

    const candidates = inputs
      .map((input) => ({ input, text: embeddingInputFor(input, client.maxInputChars) }))
      // Nothing to embed. An empty page keeps its old vector rather than
      // getting a meaningless one: it is about to be filled in.
      .filter((entry) => entry.text.length > 0)
      .map((entry) => ({ ...entry, hash: embeddingTextHash(`${model}:${entry.text}`) }));
    if (candidates.length === 0) return 0;

    const existing = await this.deps.prisma.$queryRaw<
      { documentId: string; textHash: string | null }[]
    >(Prisma.sql`
      SELECT "documentId", "textHash" FROM "document_embedding"
      WHERE "blockId" IS NULL
        AND "model" = ${model}
        AND "documentId" IN (${Prisma.join(candidates.map((entry) => entry.input.documentId))})
    `);
    const storedHashes = new Map(existing.map((row) => [row.documentId, row.textHash]));

    const pending = candidates.filter(
      (entry) => storedHashes.get(entry.input.documentId) !== entry.hash,
    );
    if (pending.length === 0) return 0;

    const vectors = await client.embed({
      texts: pending.map((entry) => entry.text),
      model,
      correlationId: `index-${pending[0]?.input.documentId ?? 'batch'}`,
    });

    let written = 0;
    for (const [position, entry] of pending.entries()) {
      const vector = vectors[position];
      if (vector === undefined) continue;
      if (vector.length !== client.dimensions) {
        throw new Error(
          `Embedding model returned ${vector.length} dimensions, the column holds ${client.dimensions}`,
        );
      }
      const literal = toVectorLiteral(vector);
      await this.deps.prisma.$transaction([
        // A page has exactly one whole-document vector. Rows written under a
        // model that is no longer configured are dead weight and would keep the
        // unique index from being the simple statement it is.
        this.deps.prisma.$executeRaw`
          DELETE FROM "document_embedding"
          WHERE "documentId" = ${entry.input.documentId} AND "blockId" IS NULL AND "model" <> ${model}
        `,
        this.deps.prisma.$executeRaw`
          INSERT INTO "document_embedding" ("id", "documentId", "blockId", "model", "embedding", "textHash", "createdAt")
          VALUES (gen_random_uuid()::text, ${entry.input.documentId}, NULL, ${model}, ${literal}::vector, ${entry.hash}, now())
          ON CONFLICT ("documentId", "blockId", "model")
          DO UPDATE SET "embedding" = EXCLUDED."embedding", "textHash" = EXCLUDED."textHash", "createdAt" = now()
        `,
      ]);
      written += 1;
    }
    return written;
  }

  /**
   * Pages that resemble one page, without anyone having linked them (issue #33).
   *
   * Costs nothing at the model: the page's own vector is already stored, so
   * this is a nearest-neighbour read and not an embedding call. That is what
   * makes it affordable to answer every time a panel opens, and it is also why
   * ADR-015 does not apply — no page text reaches a prompt here, the comparison
   * happens entirely in the database.
   *
   * The page itself is excluded, and so is every other vector of the same page:
   * only whole-document rows (`blockId IS NULL`) take part, so per-block
   * chunking (issue #36) cannot later fill the list with one page's own
   * paragraphs.
   */
  async findRelated(query: RelatedQuery): Promise<RelatedResult> {
    const semantic = await this.resolveOptions();
    if (semantic === null) return { state: 'disabled', hits: [] };

    // Read as text rather than joining against the row in place: pgvector uses
    // the HNSW index for a bound literal, but not for a vector it has to fetch
    // from another row in the same statement.
    const source = await this.deps.prisma.$queryRaw<{ embedding: string }[]>(Prisma.sql`
      SELECT "embedding"::text AS "embedding"
      FROM "document_embedding"
      WHERE "documentId" = ${query.documentId}
        AND "blockId" IS NULL
        AND "model" = ${semantic.model}
      LIMIT 1
    `);
    const literal = source[0]?.embedding;
    if (literal === undefined) return { state: 'pending', hits: [] };

    const rows = await this.deps.prisma.$queryRaw<VectorRow[]>(Prisma.sql`
      SELECT
        embedding."documentId"                     AS "documentId",
        index."workspaceId"                        AS "workspaceId",
        document."title"                           AS "title",
        document."icon"                            AS "icon",
        document."iconColor"                       AS "iconColor",
        document."type"                            AS "type",
        left(index."plainText", 200)               AS "snippet",
        1 - (embedding."embedding" <=> ${literal}::vector) AS "similarity",
        index."archivedAt"                         AS "archivedAt",
        index."updatedAt"                          AS "updatedAt"
      FROM "document_embedding" AS embedding
      JOIN "document_search_index" AS index ON index."documentId" = embedding."documentId"
      JOIN "document" AS document ON document."id" = embedding."documentId"
      WHERE index."workspaceId" = ${query.workspaceId}
        AND embedding."model" = ${semantic.model}
        AND embedding."blockId" IS NULL
        AND embedding."documentId" <> ${query.documentId}
        AND (${query.includeArchived} OR index."archivedAt" IS NULL)
        AND 1 - (embedding."embedding" <=> ${literal}::vector) >= ${query.minSimilarity}
      ORDER BY embedding."embedding" <=> ${literal}::vector
      LIMIT ${query.limit}
    `);

    return { state: 'ready', hits: rows.map(toSearchHit) };
  }

  private async resolveOptions(): Promise<SemanticOptions | null> {
    if (this.deps.embeddings === null) return null;
    return this.deps.options();
  }

  private async vectorSearch(query: SearchQuery, semantic: SemanticOptions): Promise<SearchHit[]> {
    const client = this.deps.embeddings;
    if (client === null) return [];

    const [vector] = await client.embed({
      texts: [query.query.slice(0, client.maxInputChars)],
      model: semantic.model,
      correlationId: `search-${query.workspaceId}`,
    });
    if (vector === undefined || vector.length !== client.dimensions) return [];

    const literal = toVectorLiteral(vector);
    const rows = await this.deps.prisma.$queryRaw<VectorRow[]>(Prisma.sql`
      SELECT
        embedding."documentId"                     AS "documentId",
        index."workspaceId"                        AS "workspaceId",
        document."title"                           AS "title",
        document."icon"                            AS "icon",
        document."iconColor"                       AS "iconColor",
        document."type"                            AS "type",
        left(index."plainText", 200)               AS "snippet",
        1 - (embedding."embedding" <=> ${literal}::vector) AS "similarity",
        index."archivedAt"                         AS "archivedAt",
        index."updatedAt"                          AS "updatedAt"
      FROM "document_embedding" AS embedding
      JOIN "document_search_index" AS index ON index."documentId" = embedding."documentId"
      JOIN "document" AS document ON document."id" = embedding."documentId"
      WHERE index."workspaceId" = ${query.workspaceId}
        AND embedding."model" = ${semantic.model}
        AND (${query.includeArchived} OR index."archivedAt" IS NULL)
      ORDER BY embedding."embedding" <=> ${literal}::vector
      LIMIT ${candidateCount(query.limit)}
    `);

    return rows.map(toSearchHit);
  }
}

/** One vector row as a hit. `rank` carries the cosine similarity. */
function toSearchHit(row: VectorRow): SearchHit {
  return {
    documentId: row.documentId,
    workspaceId: row.workspaceId,
    title: row.title,
    icon: row.icon,
    iconColor: row.iconColor,
    type: row.type,
    snippet: row.snippet.replace(/\s+/g, ' ').trim(),
    rank: Number(row.similarity),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Reciprocal rank fusion of two result lists.
 *
 * Positions are compared, not scores: `ts_rank_cd` and cosine similarity are
 * different units, and normalising them against each other would invent a
 * common scale that neither has. Being third in one list means the same thing
 * as being third in the other, which is the whole point of the method.
 *
 * Exported because the interesting cases (a hit in one list only, a hit in
 * both, the weight at its extremes) are unit tests, not database round trips.
 */
export function fuse(
  keywordHits: readonly SearchHit[],
  vectorHits: readonly SearchHit[],
  weight: number,
): SearchHit[] {
  const clamped = Math.min(Math.max(weight, 0), 1);
  const scores = new Map<string, number>();
  const hits = new Map<string, SearchHit>();

  const add = (list: readonly SearchHit[], listWeight: number): void => {
    list.forEach((hit, position) => {
      scores.set(
        hit.documentId,
        (scores.get(hit.documentId) ?? 0) + listWeight / (RRF_K + position + 1),
      );
      // The keyword list is added first and its snippet wins: it carries the
      // highlighted `<mark>` fragment around the words the user typed, which is
      // more use to a reader than the first 200 characters of the page.
      if (!hits.has(hit.documentId)) hits.set(hit.documentId, hit);
    });
  };

  add(keywordHits, 1 - clamped);
  add(vectorHits, clamped);

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([documentId, score]) => {
      const hit = hits.get(documentId);
      if (hit === undefined) throw new Error(`Unknown hit ${documentId}`);
      return { ...hit, rank: score };
    });
}
