import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canReadDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type DocumentPathEntry,
  type RelatedDocument,
  type RelatedDocumentsResponse,
} from '@exocortex/contracts';
import {
  collectAncestors,
  type PrismaClient,
  type SearchAdapter,
  supportsRelatedDocuments,
} from '@exocortex/database';

import { PRISMA } from '../platform/platform.module';
import { SEARCH_ADAPTER } from '../search/search.service';

import { toIconColor } from './documents.service';

/**
 * How many neighbours are offered. A panel section is read at a glance; a
 * longer list is not a better answer, it is a second search box.
 */
const RELATED_LIMIT = 8;

/**
 * Floor on cosine similarity.
 *
 * Every page has nearest neighbours, so without a floor the list is always
 * full and always looks confident. 0.35 is where this installation's own pages
 * stop sharing a subject: below it the pairs are held together by nothing more
 * than both being German prose about work.
 */
const MIN_SIMILARITY = 0.35;

/**
 * "Verwandte Notizen": pages that resemble this one without referencing it
 * (issue #33).
 *
 * The comparison is a nearest-neighbour read over vectors that already exist
 * for search, so opening the panel costs no model call and nothing is written
 * anywhere. In particular nothing is written into the page: a reference that
 * nobody set does not belong in the canonical Yjs state (ADR-004/005), so this
 * is a list to read, and following it is a decision the reader makes.
 */
@Injectable()
export class RelatedDocumentsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(SEARCH_ADAPTER) private readonly adapter: SearchAdapter,
    private readonly access: WorkspaceAccessService,
  ) {}

  async list(documentId: string, userId: string): Promise<RelatedDocumentsResponse> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    if (!supportsRelatedDocuments(this.adapter)) {
      return { documentId, state: 'disabled', related: [] };
    }

    const result = await this.adapter.findRelated({
      documentId,
      // Membership in this workspace is what granted the read above, and the
      // neighbour query is scoped to the same one: a page from a workspace the
      // caller is not in can never appear in the list.
      workspaceId: context.workspaceId,
      limit: RELATED_LIMIT,
      minSimilarity: MIN_SIMILARITY,
      // An archived page is in the trash. Suggesting it as related reading is
      // an invitation to work on something that was deliberately put away.
      includeArchived: false,
    });
    if (result.hits.length === 0) return { documentId, state: result.state, related: [] };

    // The neighbours are other people's pages, so the workspace is the
    // boundary only for a member with an unconfined credential (issue #83,
    // ADR-044). Everybody else is offered what they may already read.
    const visible = await this.access.visibleDocumentIds(context);
    const hits =
      visible === null ? result.hits : result.hits.filter((hit) => visible.has(hit.documentId));
    if (hits.length === 0) return { documentId, state: result.state, related: [] };

    const neighbourIds = hits.map((hit) => hit.documentId);
    const [rows, paths, linked] = await Promise.all([
      this.prisma.document.findMany({
        where: { id: { in: neighbourIds } },
        select: {
          id: true,
          title: true,
          type: true,
          icon: true,
          iconColor: true,
          archivedAt: true,
        },
      }),
      this.resolvePaths(context.workspaceId, neighbourIds, visible),
      this.linkedNeighbours(documentId, neighbourIds),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    const related: RelatedDocument[] = [];
    for (const hit of hits) {
      const row = byId.get(hit.documentId);
      if (row === undefined) continue;
      related.push({
        document: {
          id: row.id,
          title: row.title,
          type: row.type,
          icon: row.icon,
          iconColor: toIconColor(row.iconColor),
          archivedAt: row.archivedAt?.toISOString() ?? null,
        },
        path: paths.get(hit.documentId) ?? [],
        snippet: hit.snippet,
        similarity: hit.rank,
        linked: linked.has(hit.documentId),
      });
    }

    return { documentId, state: result.state, related };
  }

  /**
   * Which neighbours are already connected to this page, in either direction.
   *
   * Marked rather than filtered out: a page that resembles this one *and* is
   * linked from it is a confirmation, and hiding it would make the list look
   * like it had missed the obvious answer.
   */
  private async linkedNeighbours(
    documentId: string,
    neighbourIds: readonly string[],
  ): Promise<Set<string>> {
    const links = await this.prisma.documentLink.findMany({
      where: {
        OR: [
          { sourceDocumentId: documentId, targetDocumentId: { in: [...neighbourIds] } },
          { sourceDocumentId: { in: [...neighbourIds] }, targetDocumentId: documentId },
        ],
      },
      select: { sourceDocumentId: true, targetDocumentId: true },
    });

    const connected = new Set<string>();
    for (const link of links) {
      const other =
        link.sourceDocumentId === documentId ? link.targetDocumentId : link.sourceDocumentId;
      // `targetDocumentId` is null for a reference to a title no page carries;
      // such a row can only be reached through the outgoing half of the query.
      if (other !== null) connected.add(other);
    }
    return connected;
  }

  /** Ancestors of every neighbour, root first. One flat read, as in `SearchService`. */
  private async resolvePaths(
    workspaceId: string,
    documentIds: readonly string[],
    visibleIds: Set<string> | null,
  ): Promise<Map<string, DocumentPathEntry[]>> {
    const paths = new Map<string, DocumentPathEntry[]>();
    if (documentIds.length === 0) return paths;

    const all = await this.prisma.document.findMany({
      where: { workspaceId },
      select: { id: true, parentId: true, title: true },
    });
    // A path is a list of titles, so it is filtered like the hits themselves.
    const rows = visibleIds === null ? all : all.filter((row) => visibleIds.has(row.id));

    for (const documentId of documentIds) {
      paths.set(
        documentId,
        collectAncestors(rows, documentId).map((row) => ({ id: row.id, title: row.title })),
      );
    }
    return paths;
  }
}
