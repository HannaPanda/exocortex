import { type Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';

import { chainCovers, hashShareToken, looksLikeShareToken } from '@exocortex/auth';
import {
  type PublicShareResponse,
  type SharePermission,
  type ShareScope,
} from '@exocortex/contracts';
import { loadAncestorChain, type PrismaClient } from '@exocortex/database';
import { serializeMarkdown, yjsStateToProseMirrorJson } from '@exocortex/editor';
import { type ObjectStorage } from '@exocortex/storage';

import { AppError } from '../common/app-error';
import { OBJECT_STORAGE, PRISMA } from '../platform/platform.module';

/**
 * The anonymous half of a share (issue #83, ADR-044).
 *
 * Everything an authenticated caller reaches goes through
 * `WorkspaceAccessService`, which starts from a user id. A public link has no
 * user, so it cannot: there is nobody to look up a membership for, and
 * inventing an anonymous principal to feed into that service would mean every
 * policy in the system suddenly having to consider one.
 *
 * So this is a deliberately separate, deliberately tiny surface: three reads
 * (a page, a page inside a shared branch, a file on one of them) and nothing
 * else. Nothing here takes a workspace id, nothing here writes, and the shape
 * it answers with (`publicSharePageSchema`) is not the shape the application
 * uses -- a field that is not in the schema cannot be leaked by a renderer
 * that forgot to omit it.
 */

interface ResolvedShare {
  shareId: string;
  workspaceId: string;
  workspaceName: string;
  rootId: string;
  scope: ShareScope;
  permission: SharePermission;
  sharedByName: string;
}

/**
 * Rewrites the attachment addresses inside a page so they point at the
 * public route rather than the authenticated one.
 *
 * Without this every image on a shared page is a broken image: the editor
 * writes `/api/attachments/<id>/download`, which needs a session. The
 * replacement is textual on purpose -- the alternative is teaching the
 * Markdown serializer about share tokens, and a serializer that knows about
 * credentials is one that can put one in a file somebody exports.
 */
function rewriteAttachmentLinks(markdown: string, token: string): string {
  return markdown.replaceAll(
    /\/api\/attachments\/([A-Za-z0-9_-]+)\/download/g,
    (_match, attachmentId: string) =>
      `/api/share/${encodeURIComponent(token)}/attachments/${attachmentId}`,
  );
}

@Injectable()
export class PublicSharesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /**
   * One page behind a link.
   *
   * `documentId` is how a reader walks into a sub-page of a SUBTREE link. Left
   * out, the link's own page is meant.
   */
  async read(token: string, documentId?: string): Promise<PublicShareResponse> {
    const share = await this.resolve(token);
    const targetId = documentId ?? share.rootId;
    const chain = await this.requireInScope(share, targetId);

    const document = await this.prisma.document.findUnique({
      where: { id: targetId },
      select: { id: true, title: true, icon: true, updatedAt: true, archivedAt: true },
    });
    // An archived page answers like a missing one. Putting a page in the trash
    // is a statement that it is out of use, and a link that kept serving it
    // would quietly disagree.
    if (document === null || document.archivedAt !== null) {
      throw new AppError('share_link_invalid', 'This link does not lead anywhere');
    }

    const content = await this.prisma.documentContent.findUnique({
      where: { documentId: targetId },
      select: { yjsState: true },
    });
    const markdown =
      content === null
        ? ''
        : rewriteAttachmentLinks(
            serializeMarkdown(yjsStateToProseMirrorJson(content.yjsState)),
            token,
          );

    const children =
      share.scope === 'SUBTREE'
        ? await this.prisma.document.findMany({
            where: { parentId: targetId, archivedAt: null },
            select: { id: true, title: true, icon: true },
            orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
            take: 200,
          })
        : [];

    // The chain runs from the page upwards; the reader wants it downwards, and
    // only as far as the shared root. Where that root sits in the workspace is
    // not part of what was shared, so the walk simply stops there.
    const upToRoot = chain.slice(0, chain.indexOf(share.rootId) + 1).reverse();
    const titles = await this.prisma.document.findMany({
      where: { id: { in: upToRoot } },
      select: { id: true, title: true },
    });
    const titleById = new Map(titles.map((row) => [row.id, row.title]));

    return {
      page: {
        documentId: document.id,
        title: document.title,
        icon: document.icon,
        markdown,
        updatedAt: document.updatedAt.toISOString(),
        children: children.map((child) => ({
          documentId: child.id,
          title: child.title,
          icon: child.icon,
        })),
        path: upToRoot.map((id) => ({ documentId: id, title: titleById.get(id) ?? '' })),
        workspaceName: share.workspaceName,
        sharedByName: share.sharedByName,
      },
    };
  }

  /** A file hanging on a page the link covers. */
  async downloadAttachment(
    token: string,
    attachmentId: string,
  ): Promise<{ stream: Readable; filename: string; mimeType: string; byteSize: number }> {
    const share = await this.resolve(token);
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: {
        documentId: true,
        deletedAt: true,
        storageKey: true,
        filename: true,
        mimeType: true,
        byteSize: true,
      },
    });
    // A file that hangs on no page is workspace-level and belongs to nobody
    // here: a link covers pages, and everything else is refused rather than
    // reasoned about.
    if (attachment === null || attachment.deletedAt !== null || attachment.documentId === null) {
      throw new AppError('share_link_invalid', 'This link does not lead anywhere');
    }
    await this.requireInScope(share, attachment.documentId);

    return {
      stream: await this.storage.getObject({ key: attachment.storageKey }),
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
    };
  }

  /**
   * Token to grant.
   *
   * Unknown, withdrawn and expired all answer `share_link_invalid` with the
   * same status: an anonymous caller must not be able to tell a wrong guess
   * from a right guess that has since been taken back.
   */
  private async resolve(token: string): Promise<ResolvedShare> {
    if (!looksLikeShareToken(token)) {
      throw new AppError('share_link_invalid', 'This link does not lead anywhere');
    }
    const row = await this.prisma.documentShare.findUnique({
      where: { tokenHash: hashShareToken(token) },
      select: {
        id: true,
        workspaceId: true,
        documentId: true,
        kind: true,
        scope: true,
        permission: true,
        revokedAt: true,
        expiresAt: true,
        createdBy: { select: { name: true } },
        workspace: { select: { name: true } },
      },
    });
    if (
      row === null ||
      row.kind !== 'PUBLIC_LINK' ||
      row.revokedAt !== null ||
      (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now())
    ) {
      throw new AppError('share_link_invalid', 'This link does not lead anywhere');
    }
    return {
      shareId: row.id,
      workspaceId: row.workspaceId,
      workspaceName: row.workspace.name,
      rootId: row.documentId,
      scope: row.scope,
      permission: row.permission,
      sharedByName: row.createdBy.name,
    };
  }

  /** The page's chain of ancestors, once it is established the link covers it. */
  private async requireInScope(share: ResolvedShare, documentId: string): Promise<string[]> {
    const chain = await loadAncestorChain(this.prisma, documentId);
    if (!chainCovers(chain, share.rootId, share.scope)) {
      throw new AppError('share_link_invalid', 'This link does not lead anywhere');
    }
    return chain;
  }
}
