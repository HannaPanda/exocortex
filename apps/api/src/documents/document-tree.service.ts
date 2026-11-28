import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceAccessService } from '@exocortex/auth';
import {
  type DocumentTreeNode,
  type DocumentTreeRequest,
  type DocumentTreeResponse,
  type ResolveDocumentLinkRequest,
  type ResolveDocumentLinkResponse,
} from '@exocortex/contracts';
import {
  buildTree,
  collectAncestors,
  collectDescendantIds,
  type PrismaClient,
} from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';

import {
  DOCUMENT_SELECT,
  type DocumentRow,
  type ResolveLinkRow,
  toLinkMatch,
  toSummary,
} from './document-shape';

/**
 * Reading the hierarchy: the tree itself, and finding the page a `[[title]]`
 * means.
 *
 * Both answer the same question from different directions ("what is where"),
 * both are read-only, and both are the parts a caller with a context window
 * has to be protected from: they are the two places that can return a whole
 * workspace at once.
 */
@Injectable()
export class DocumentTreeService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
  ) {}

  /**
   * The workspace hierarchy, or one branch of it.
   *
   * `parentId` narrows the answer to what sits below a single page, which is
   * what makes a truncated tree usable: a caller told "417 pages were left out"
   * needs a way to ask about one section instead of the whole workspace.
   * `depth` cuts the answer off after that many levels below the starting
   * point. `totalCount` always reports the untruncated size of the scope, so a
   * renderer knows how much it is not showing.
   */
  async getTree(
    workspaceId: string,
    userId: string,
    request: DocumentTreeRequest = {},
  ): Promise<DocumentTreeResponse> {
    // A recipient of page grants gets the pages those grants reach and
    // nothing else (issue #327): the branch below a shared page, never what
    // sits above it or beside it. `buildTree` makes each shared page a root,
    // because its parent is not in the list.
    const scoped = await this.access.requireScopedReach(workspaceId, userId);

    const all = await this.prisma.document.findMany({
      where: { workspaceId },
      select: DOCUMENT_SELECT,
      orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
    });
    // A confined credential is told about its branches and nothing else, not
    // even that the rest exists (issue #83, ADR-044). Filtering the flat list
    // before the tree is built is what makes the pages above a scope root
    // disappear rather than turn into a root of their own: `buildTree` treats
    // a node whose parent is missing as a root, which is exactly right here.
    const rows =
      scoped.documentIds === null
        ? all
        : all.filter((row) => (scoped.documentIds as Set<string>).has(row.id));

    const parentId = request.parentId;
    // A `parentId` from another workspace must not silently answer with that
    // workspace's root level, which is what filtering alone would do.
    if (parentId !== undefined && !rows.some((row) => row.id === parentId)) {
      throw AppError.notFound('Document');
    }

    const scope =
      parentId === undefined
        ? rows
        : (() => {
            const descendants = collectDescendantIds(rows, parentId);
            return rows.filter((row) => descendants.has(row.id));
          })();

    const active = scope.filter((row) => row.archivedAt === null);
    // The trash belongs to the workspace, not to the pages somebody was handed.
    const archived =
      scoped.throughGrants === true ? [] : scope.filter((row) => row.archivedAt !== null);

    // Only a database *below* the starting point loses its rows: the roots of
    // a branch asked for by a database's own id are its rows, and they never
    // pass through this check as a database.
    const countRows = request.rows === 'count';

    const toNode = (
      entry: {
        node: DocumentRow;
        children: { node: DocumentRow; children: unknown[] }[];
      },
      remainingDepth: number,
    ): DocumentTreeNode =>
      countRows && entry.node.type === 'COLLECTION'
        ? { ...toSummary(entry.node), children: [], rowCount: entry.children.length }
        : {
            ...toSummary(entry.node),
            children:
              remainingDepth <= 1
                ? []
                : entry.children.map((child) =>
                    toNode(
                      child as {
                        node: DocumentRow;
                        children: { node: DocumentRow; children: unknown[] }[];
                      },
                      remainingDepth - 1,
                    ),
                  ),
          };

    const depth = request.depth ?? Number.POSITIVE_INFINITY;

    return {
      nodes: buildTree(active).map((entry) =>
        toNode(
          entry as unknown as {
            node: DocumentRow;
            children: { node: DocumentRow; children: unknown[] }[];
          },
          depth,
        ),
      ),
      archived: archived.map(toSummary),
      path:
        parentId === undefined
          ? []
          : [...collectAncestors(rows, parentId), rows.find((row) => row.id === parentId)]
              .filter((row): row is DocumentRow => row !== undefined)
              .map((row) => ({ id: row.id, title: row.title })),
      totalCount: active.length,
    };
  }

  /**
   * Resolves a reference to another page to the document(s) it means,
   * workspace-scoped.
   *
   * Identity first: a `pageLink` block stores the target's `documentId`, and
   * honouring that is what keeps every reference intact when the target is
   * renamed (issue #14). The title is the fallback — for the notations that
   * carry nothing else (`[[Titel]]`, a page mention, a link made before
   * identities existed) and for a target that was deleted and written again
   * under the same name. A reference must not silently vanish, so `resolvedBy`
   * reports which of the two answered.
   *
   * Raw SQL for the title lookup, not `findMany({ title: { equals, mode:
   * 'insensitive' } })`: Prisma translates `insensitive` to `ILIKE` without
   * escaping `%`/`_` in the value, so a page titled e.g. "100%_Plan" would
   * match unrelated titles. `lower` + `regexp_replace` on both sides keeps the
   * comparison exact and predictable.
   */
  async resolveLink(
    workspaceId: string,
    userId: string,
    request: ResolveDocumentLinkRequest,
  ): Promise<ResolveDocumentLinkResponse> {
    // A link on a shared page resolves for its recipient when its target is
    // a page their grants reach, and to nothing otherwise (issue #327).
    const scoped = await this.access.requireScopedReach(workspaceId, userId);
    const visible = (documentId: string): boolean =>
      scoped.documentIds === null || scoped.documentIds.has(documentId);

    const title = (request.title ?? '').trim().replace(/\s+/g, ' ');

    if (request.documentId !== undefined) {
      const byId = await this.prisma.document.findFirst({
        where: {
          id: request.documentId,
          workspaceId,
          ...(request.includeArchived ? {} : { archivedAt: null }),
        },
        select: {
          id: true,
          workspaceId: true,
          type: true,
          title: true,
          icon: true,
          iconColor: true,
          archivedAt: true,
        },
      });
      // The identity is unambiguous by definition, so no path is needed and no
      // second query runs. Only when it no longer names a document does the
      // title get its turn below.
      if (byId !== null && visible(byId.id)) {
        return { title: byId.title, matches: [toLinkMatch(byId, [])], resolvedBy: 'id' };
      }
    }

    if (title.length === 0) return { title, matches: [], resolvedBy: 'none' };

    const matched = await this.prisma.$queryRaw<ResolveLinkRow[]>`
      SELECT "id", "workspaceId", "type", "title", "icon", "iconColor", "archivedAt"
      FROM "document"
      WHERE "workspaceId" = ${workspaceId}
        AND lower(btrim(regexp_replace("title", '\\s+', ' ', 'g'))) = lower(${title})
        AND (${request.includeArchived}::boolean OR "archivedAt" IS NULL)
      ORDER BY ("archivedAt" IS NOT NULL) ASC, "updatedAt" DESC, "id" ASC
      LIMIT ${request.limit}
    `;
    // A reference that points outside what this credential may see resolves to
    // nothing, exactly as if the page had been deleted (issue #83). Saying
    // "there is a page called that, you may not have it" would answer the
    // question the confinement exists to refuse.
    const rows = matched.filter((row) => visible(row.id));

    if (rows.length <= 1) {
      return {
        title,
        matches: rows.map((row) => toLinkMatch(row, [])),
        resolvedBy: rows.length === 0 ? 'none' : 'title',
      };
    }

    // Only worth the extra query when the caller actually has to disambiguate.
    const allSiblings = await this.prisma.document.findMany({
      where: { workspaceId },
      select: { id: true, parentId: true, orderKey: true, title: true },
    });
    const siblings = allSiblings.filter((row) => visible(row.id));

    return {
      title,
      matches: rows.map((row) =>
        toLinkMatch(
          row,
          collectAncestors(siblings, row.id).map((ancestor) => ({
            id: ancestor.id,
            title: ancestor.title,
          })),
        ),
      ),
      resolvedBy: 'title',
    };
  }
}
