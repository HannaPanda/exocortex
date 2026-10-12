import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceAccessService } from '@exocortex/auth';
import {
  type KnowledgeMapEdge,
  type KnowledgeMapEdgeKind,
  type KnowledgeMapNode,
  type KnowledgeMapResponse,
  type KnowledgeMapSemanticState,
} from '@exocortex/contracts';
import {
  type PrismaClient,
  type SearchAdapter,
  supportsRelatedDocuments,
} from '@exocortex/database';

import { toIconColor } from '../documents/documents.service';
import { PRISMA } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';
import { SEARCH_ADAPTER } from '../search/search.service';

import { parseVector, SimilarityIndex, type SimilarPair } from './similarity';

/**
 * How many similarity lines a page draws at most, and from which cosine on.
 *
 * Higher than the 0.35 of "Verwandte Notizen" on purpose. That panel lists
 * eight candidates for one page and the reader judges them; the map draws the
 * lines of every page at once, and at 0.35 the whole workspace becomes one
 * felt of German prose about work. From 0.55 on, a line means a shared subject.
 */
const SIMILAR_PER_PAGE = 3;
const SIMILAR_MIN = 0.55;

/** A reference made this often or more draws at full strength. */
const LINK_FULL_WEIGHT_AT = 4;

interface DocumentRow {
  id: string;
  parentId: string | null;
  type: 'PAGE' | 'COLLECTION' | 'PROJECT';
  title: string;
  icon: string | null;
  iconColor: string | null;
  createdAt: Date;
  updatedAt: Date;
  content: { yjsUpdatedAt: Date | null } | null;
}

interface SimilarityAnswer {
  pairs: SimilarPair[];
  vectorCount: number;
}

/**
 * The knowledge map (issue #189): every page of a workspace, and every kind of
 * connection between two of them, in one answer.
 *
 * A read model in the sense of `WorkspaceOverviewService`. It writes nothing
 * and owns nothing: references come from the index materialization keeps,
 * similarities from the search vectors, entity lines from the entity layer.
 * The one thing it keeps is the similarity index, in memory and per
 * workspace, because comparing every vector with every other is the only
 * expensive part and a vector only changes when a page is re-embedded.
 */
@Injectable()
export class KnowledgeMapService {
  private readonly similarityIndexes = new Map<string, SimilarityIndex>();
  private readonly similarityLocks = new Map<string, Promise<void>>();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SEARCH_ADAPTER) private readonly adapter: SearchAdapter,
    private readonly access: WorkspaceAccessService,
    private readonly settings: SettingsService,
  ) {}

  async get(
    workspaceId: string,
    userId: string,
    exclude: readonly KnowledgeMapEdgeKind[] = [],
  ): Promise<KnowledgeMapResponse> {
    // The whole workspace at once, so a credential confined to some pages is
    // refused here rather than shown a filtered map (ADR-044): which pages
    // exist around a branch is itself what a confinement withholds.
    await this.access.requireRole(workspaceId, userId);
    const skip = new Set(exclude);

    const rows = await this.prisma.document.findMany({
      where: { workspaceId, archivedAt: null },
      select: {
        id: true,
        parentId: true,
        type: true,
        title: true,
        icon: true,
        iconColor: true,
        createdAt: true,
        updatedAt: true,
        content: { select: { yjsUpdatedAt: true } },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const entityDatabaseId = await this.entityDatabaseId();

    const edges = new EdgeCollector((id) => byId.has(id));
    // The tree is always known as a connection, shown or not, so hiding it
    // does not suddenly turn every parent and child into a "similar" pair.
    for (const row of rows) {
      if (row.parentId !== null) edges.add(row.parentId, row.id, 'tree', 1, !skip.has('tree'));
    }
    if (!skip.has('link')) await this.addLinks(workspaceId, edges);
    if (!skip.has('entity')) await this.addEntityMentions(workspaceId, edges);

    let semantic: KnowledgeMapSemanticState = 'disabled';
    if (!skip.has('similar') && supportsRelatedDocuments(this.adapter)) {
      const similarity = await this.similarity(workspaceId);
      semantic = similarity.vectorCount < rows.length ? 'partial' : 'ok';
      for (const pair of similarity.pairs) {
        // A pair that is already connected says nothing new as a similarity:
        // the point of the line is the connection nobody drew.
        if (edges.connects(pair.source, pair.target)) continue;
        const weight = (pair.similarity - SIMILAR_MIN) / (1 - SIMILAR_MIN);
        edges.add(pair.source, pair.target, 'similar', weight);
      }
    }

    const degree = new Map<string, number>();
    for (const edge of edges.list) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }

    const nodes: KnowledgeMapNode[] = rows.map((row) => ({
      id: row.id,
      kind: entityDatabaseId !== null && row.parentId === entityDatabaseId ? 'entity' : 'page',
      title: row.title,
      type: row.type,
      icon: row.icon,
      iconColor: toIconColor(row.iconColor),
      parentId: row.parentId !== null && byId.has(row.parentId) ? row.parentId : null,
      rootId: rootOf(row, byId),
      degree: degree.get(row.id) ?? 0,
      createdAt: row.createdAt.toISOString(),
      editedAt: editedAt(row).toISOString(),
    }));

    return {
      workspaceId,
      generatedAt: new Date().toISOString(),
      semantic,
      nodes,
      edges: edges.list,
    };
  }

  /** References between two pages, one line per pair and direction, weighted by how often. */
  private async addLinks(workspaceId: string, edges: EdgeCollector): Promise<void> {
    const links = await this.prisma.documentLink.groupBy({
      by: ['sourceDocumentId', 'targetDocumentId'],
      where: { workspaceId, targetDocumentId: { not: null } },
      _count: { _all: true },
    });
    for (const link of links) {
      if (link.targetDocumentId === null) continue;
      const weight = link._count._all / LINK_FULL_WEIGHT_AT;
      edges.add(link.sourceDocumentId, link.targetDocumentId, 'link', weight);
    }
  }

  /** A page naming an entity, weighted by how often it does. */
  private async addEntityMentions(workspaceId: string, edges: EdgeCollector): Promise<void> {
    const mentions = await this.prisma.entityMention.findMany({
      where: { workspaceId },
      select: { documentId: true, entityDocumentId: true, occurrences: true },
    });
    for (const mention of mentions) {
      const weight = mention.occurrences / LINK_FULL_WEIGHT_AT;
      edges.add(mention.documentId, mention.entityDocumentId, 'entity', weight);
    }
  }

  private async entityDatabaseId(): Promise<string | null> {
    const settings = await this.settings.get();
    return settings['entities.enabled'] ? settings['entities.databaseId'] : null;
  }

  /**
   * The similarity pairs of a workspace, from an index kept in memory and
   * brought up to date before every answer. Asking whether anything changed
   * costs one read of ids and stamps; only the vectors that did change are
   * fetched and compared. Updates of one workspace run one after another, so
   * two map requests at once never apply the same change twice.
   */
  private async similarity(workspaceId: string): Promise<SimilarityAnswer> {
    const previous = this.similarityLocks.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(() => this.refreshSimilarity(workspaceId));
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.similarityLocks.set(workspaceId, settled);
    try {
      return await next;
    } finally {
      if (this.similarityLocks.get(workspaceId) === settled)
        this.similarityLocks.delete(workspaceId);
    }
  }

  private async refreshSimilarity(workspaceId: string): Promise<SimilarityAnswer> {
    // The whole-document row only (`blockId IS NULL`), never the passages:
    // the map is about pages, like `findRelated` (ADR-034). Newest first, so a
    // page embedded under two models keeps the newer vector.
    const stamps = await this.prisma.$queryRaw<{ documentId: string; createdAt: Date }[]>`
      SELECT DISTINCT ON (e."documentId") e."documentId" AS "documentId", e."createdAt" AS "createdAt"
      FROM document_embedding e
      JOIN document d ON d.id = e."documentId"
      WHERE d."workspaceId" = ${workspaceId}
        AND d."archivedAt" IS NULL
        AND e."blockId" IS NULL
        AND e.embedding IS NOT NULL
      ORDER BY e."documentId", e."createdAt" DESC
    `;
    const versions = new Map(stamps.map((row) => [row.documentId, row.createdAt.toISOString()]));

    let index = this.similarityIndexes.get(workspaceId);
    if (index === undefined) {
      index = new SimilarityIndex(SIMILAR_MIN);
      this.similarityIndexes.set(workspaceId, index);
    }

    const stale = index.stale(versions);
    const changed = new Map<string, Float32Array>();
    if (stale.length > 0) {
      const rows = await this.prisma.$queryRaw<{ documentId: string; embedding: string }[]>`
        SELECT DISTINCT ON (e."documentId") e."documentId" AS "documentId", e.embedding::text AS embedding
        FROM document_embedding e
        WHERE e."documentId" = ANY(${stale})
          AND e."blockId" IS NULL
          AND e.embedding IS NOT NULL
        ORDER BY e."documentId", e."createdAt" DESC
      `;
      for (const row of rows) {
        const vector = parseVector(row.embedding);
        if (vector !== null) changed.set(row.documentId, vector);
      }
    }
    await index.apply(versions, changed);
    return { pairs: index.pairs(SIMILAR_PER_PAGE), vectorCount: index.size };
  }
}

/**
 * The lines of a map as they are found: only between two points on the map,
 * never from a point to itself, weights clamped to 0..1, and a record of which
 * pairs are already connected by something other than similarity.
 */
class EdgeCollector {
  readonly list: KnowledgeMapEdge[] = [];
  private readonly pairs = new Set<string>();

  constructor(private readonly onMap: (id: string) => boolean) {}

  add(
    source: string,
    target: string,
    kind: KnowledgeMapEdgeKind,
    weight: number,
    show = true,
  ): void {
    if (source === target || !this.onMap(source) || !this.onMap(target)) return;
    this.pairs.add(pairKey(source, target));
    if (show) this.list.push({ source, target, kind, weight: Math.max(0, Math.min(1, weight)) });
  }

  connects(a: string, b: string): boolean {
    return this.pairs.has(pairKey(a, b));
  }
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** The later of the row's own change and the last write to the body. */
function editedAt(row: DocumentRow): Date {
  const yjs = row.content?.yjsUpdatedAt;
  if (yjs === undefined || yjs === null) return row.updatedAt;
  return yjs.getTime() > row.updatedAt.getTime() ? yjs : row.updatedAt;
}

/** The top-level page above a row, the row itself at top level. Bounded like a path. */
function rootOf(row: DocumentRow, byId: Map<string, DocumentRow>): string {
  let current = row;
  for (let depth = 0; depth < 32; depth += 1) {
    if (current.parentId === null) return current.id;
    const parent = byId.get(current.parentId);
    if (parent === undefined) return current.id;
    current = parent;
  }
  return current.id;
}
