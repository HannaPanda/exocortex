import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceAccessService } from '@exocortex/auth';
import {
  type AttentionItem,
  type DocumentPathEntry,
  type DocumentType,
  type OverviewDocument,
  type WorkspaceOverviewResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { toIconColor } from '../documents/documents.service';
import { PRISMA } from '../platform/platform.module';

/** How many rows each list of the landing view is allowed to draw. */
const RECENT_LIMIT = 6;
const ATTENTION_LIMIT = 4;
const WEEK_IN_MS = 7 * 24 * 60 * 60 * 1000;

interface DocumentRow {
  id: string;
  parentId: string | null;
  type: DocumentType;
  title: string;
  icon: string | null;
  iconColor: string | null;
  orderKey: string;
  updatedAt: Date;
  updatedBy: { name: string } | null;
  content: { yjsUpdatedAt: Date } | null;
}

/**
 * The later of the two timestamps a page has.
 *
 * `Document.updatedAt` only moves when the row itself changes: a rename, a
 * move, an icon. The body lives in Yjs and stamps `DocumentContent.yjsUpdatedAt`
 * instead. Ranking by the row alone would put a rename above an hour of
 * writing; ranking by Yjs alone would drop every page whose body was never
 * opened. The answer is the maximum of both.
 */
function editedAt(row: DocumentRow): Date {
  const yjs = row.content?.yjsUpdatedAt;
  if (yjs === undefined || yjs === null) return row.updatedAt;
  return yjs.getTime() > row.updatedAt.getTime() ? yjs : row.updatedAt;
}

/** Walks up the parent chain. Root first, the document itself excluded. */
function pathOf(row: DocumentRow, byId: Map<string, DocumentRow>): DocumentPathEntry[] {
  const path: DocumentPathEntry[] = [];
  let parentId = row.parentId;
  // A cycle cannot be written through the move endpoint, but a bounded loop
  // costs nothing and a landing view must never be the thing that hangs.
  while (parentId !== null && path.length < 12) {
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    path.unshift({ id: parent.id, title: parent.title });
    parentId = parent.parentId;
  }
  return path;
}

/** Size of the branch under a page, all levels, the page itself excluded. */
function countDescendants(rootId: string, children: Map<string, string[]>): number {
  let total = 0;
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) continue;
    for (const child of children.get(current) ?? []) {
      total += 1;
      queue.push(child);
    }
  }
  return total;
}

function toOverviewDocument(row: DocumentRow, byId: Map<string, DocumentRow>): OverviewDocument {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    iconColor: toIconColor(row.iconColor),
    type: row.type,
    path: pathOf(row, byId),
  };
}

/**
 * Everything the landing view of a workspace shows, assembled in one place.
 *
 * Kept out of `WorkspacesService`: this is a read model over documents,
 * comments, references and attachments, and none of that is the workspace
 * aggregate's own business.
 */
@Injectable()
export class WorkspaceOverviewService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
  ) {}

  async get(workspaceId: string, userId: string): Promise<WorkspaceOverviewResponse> {
    await this.access.requireRole(workspaceId, userId);

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true, _count: { select: { members: true } } },
    });
    if (workspace === null) throw AppError.notFound('Workspace');

    const rows = await this.loadDocuments(workspaceId);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const children = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parentId === null) continue;
      const siblings = children.get(row.parentId);
      if (siblings === undefined) children.set(row.parentId, [row.id]);
      else siblings.push(row.id);
    }

    const [attachments, attention] = await Promise.all([
      this.prisma.attachment.aggregate({
        where: { workspaceId, deletedAt: null },
        _count: { _all: true },
        _sum: { byteSize: true },
      }),
      this.loadAttention(workspaceId, byId),
    ]);

    const since = Date.now() - WEEK_IN_MS;
    const pages = rows.filter((row) => row.type === 'PAGE' && !this.isDatabaseRow(row, byId));
    const databases = rows.filter((row) => row.type === 'COLLECTION');

    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      stats: {
        pageCount: pages.length,
        databaseCount: databases.length,
        editedThisWeek: rows.filter((row) => editedAt(row).getTime() >= since).length,
        memberCount: workspace._count.members,
        attachmentCount: attachments._count._all,
        attachmentBytes: attachments._sum.byteSize ?? 0,
      },
      recentlyEdited: rows
        .slice()
        .sort((a, b) => editedAt(b).getTime() - editedAt(a).getTime())
        .slice(0, RECENT_LIMIT)
        .map((row) => ({
          ...toOverviewDocument(row, byId),
          editedAt: editedAt(row).toISOString(),
          editedByName: row.updatedBy?.name ?? null,
        })),
      databases: databases
        .sort((a, b) => a.orderKey.localeCompare(b.orderKey))
        .map((row) => ({
          ...toOverviewDocument(row, byId),
          rowCount: children.get(row.id)?.length ?? 0,
        })),
      // Databases have their own block above. A top-level database listed in
      // both would be the same entry twice, once with the size of its table and
      // once with the size of its branch, which are the same number.
      sections: rows
        .filter((row) => row.parentId === null && row.type !== 'COLLECTION')
        .sort((a, b) => a.orderKey.localeCompare(b.orderKey))
        .map((row) => ({
          ...toOverviewDocument(row, byId),
          descendantCount: countDescendants(row.id, children),
        })),
      attention,
    };
  }

  /** A row of a database is a `PAGE` whose parent is the `COLLECTION`. */
  private isDatabaseRow(row: DocumentRow, byId: Map<string, DocumentRow>): boolean {
    if (row.parentId === null) return false;
    return byId.get(row.parentId)?.type === 'COLLECTION';
  }

  private async loadDocuments(workspaceId: string): Promise<DocumentRow[]> {
    return this.prisma.document.findMany({
      where: { workspaceId, archivedAt: null },
      select: {
        id: true,
        parentId: true,
        type: true,
        title: true,
        icon: true,
        iconColor: true,
        orderKey: true,
        updatedAt: true,
        updatedBy: { select: { name: true } },
        content: { select: { yjsUpdatedAt: true } },
      },
    });
  }

  /**
   * The four things that quietly pile up: unresolved threads, references
   * pointing at nothing, attachments whose text extraction never finished, and
   * pages that open by saying their own title again. Each answers with a count
   * and the first few pages to click on, because a count on its own only tells
   * the reader to go looking.
   */
  private async loadAttention(
    workspaceId: string,
    byId: Map<string, DocumentRow>,
  ): Promise<WorkspaceOverviewResponse['attention']> {
    const [comments, links, stalled, repeatedTitles] = await Promise.all([
      this.prisma.comment.groupBy({
        by: ['documentId'],
        where: { workspaceId, resolvedAt: null, parentId: null },
        _count: { _all: true },
      }),
      this.prisma.documentLink.groupBy({
        by: ['sourceDocumentId'],
        where: { workspaceId, targetDocumentId: null },
        _count: { _all: true },
      }),
      this.prisma.attachment.groupBy({
        by: ['documentId'],
        where: { workspaceId, deletedAt: null, textStatus: { in: ['PENDING', 'FAILED'] } },
        _count: { _all: true },
      }),
      /*
       * Pages whose first block is a first-level heading that starts with the
       * page's own title. Raw SQL because the condition compares two columns of
       * two tables, one of them inside a JSON document, which no Prisma filter
       * expresses -- and because it has to stay one indexed scan: this runs
       * every time somebody opens a workspace.
       *
       * `starts_with` rather than `LIKE`: a title containing `%` or `_` is
       * ordinary text, not a pattern, and nobody should have to escape it here.
       */
      this.prisma.$queryRaw<{ documentId: string }[]>`
        SELECT d.id AS "documentId"
        FROM document d
        JOIN document_content c ON c."documentId" = d.id
        WHERE d."workspaceId" = ${workspaceId}
          AND d."archivedAt" IS NULL
          AND d.type = 'PAGE'
          AND c."plainText" IS NOT NULL
          AND c."proseMirrorJson" -> 'content' -> 0 ->> 'type' = 'heading'
          AND c."proseMirrorJson" -> 'content' -> 0 -> 'attrs' ->> 'level' = '1'
          AND starts_with(lower(split_part(c."plainText", E'\n', 1)), lower(d.title))
      `,
    ]);

    const collect = (groups: { id: string | null; count: number }[]): AttentionItem => {
      const visible = groups.filter((group) => group.id !== null && byId.has(group.id));
      return {
        count: visible.reduce((sum, group) => sum + group.count, 0),
        documents: visible.slice(0, ATTENTION_LIMIT).flatMap((group) => {
          const row = group.id === null ? undefined : byId.get(group.id);
          return row === undefined ? [] : [toOverviewDocument(row, byId)];
        }),
      };
    };

    return {
      openComments: collect(
        comments.map((group) => ({ id: group.documentId, count: group._count._all })),
      ),
      brokenLinks: collect(
        links.map((group) => ({ id: group.sourceDocumentId, count: group._count._all })),
      ),
      stalledAttachments: collect(
        stalled.map((group) => ({ id: group.documentId, count: group._count._all })),
      ),
      duplicateTitleHeadings: collect(
        repeatedTitles.map((row) => ({ id: row.documentId, count: 1 })),
      ),
    };
  }
}
