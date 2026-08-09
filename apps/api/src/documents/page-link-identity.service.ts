import { Inject, Injectable } from '@nestjs/common';

import { type PrismaClient } from '@exocortex/database';
import {
  bindPageLinkIdentities,
  documentLinkTitleKey,
  type ProseMirrorDocument,
  resolvePageLinkTitles,
} from '@exocortex/editor';

import { PRISMA } from '../platform/platform.module';

/**
 * The two lookups the Markdown boundary needs, both answered from one read of
 * the workspace.
 *
 * Deliberately a snapshot rather than a query per reference: a document being
 * imported can name dozens of pages, and `packages/editor`'s transforms are
 * pure and synchronous by design (they must run on the server *and* in the
 * editor). Reading `(id, title)` for a workspace once is the same shape of
 * read the document tree and the ambiguous-link path already do.
 */
export interface PageIdentityIndex {
  /** Identity of the page carrying `title`, or `null`. */
  identityFor(title: string): string | null;
  /** Title the page with `documentId` carries now, or `null` when it is gone. */
  titleFor(documentId: string): string | null;
}

/**
 * Keeps `[[Titel]]` an interchange format while references are identities
 * (issue #14).
 *
 * Export resolves every identity to the title its target carries *now*, so a
 * file written after a rename says the new name. Import maps every title back
 * onto a page of the workspace, so an imported reference survives the next
 * rename instead of quietly rotting. Both directions are pure functions in
 * `@exocortex/editor`; this service only supplies them with what the database
 * knows.
 */
@Injectable()
export class PageLinkIdentityService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async loadIndex(workspaceId: string): Promise<PageIdentityIndex> {
    const rows = await this.prisma.document.findMany({
      where: { workspaceId },
      select: { id: true, title: true, archivedAt: true, updatedAt: true },
      // Same precedence as `DocumentsService.resolveLink`, so an imported title
      // binds to the page a reader following that same link would land on.
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });

    const byTitle = new Map<string, string>();
    const byId = new Map<string, string>();
    // Two passes so an archived page never displaces a live one with the same
    // title, whatever their update times are.
    for (const row of rows) {
      byId.set(row.id, row.title);
      const key = documentLinkTitleKey(row.title);
      if (key.length === 0 || row.archivedAt !== null) continue;
      if (!byTitle.has(key)) byTitle.set(key, row.id);
    }
    for (const row of rows) {
      const key = documentLinkTitleKey(row.title);
      if (key.length === 0) continue;
      if (!byTitle.has(key)) byTitle.set(key, row.id);
    }

    return {
      identityFor: (title) => byTitle.get(documentLinkTitleKey(title)) ?? null,
      titleFor: (documentId) => byId.get(documentId) ?? null,
    };
  }

  /** Binds every reference that carries only a title to a page of this workspace. */
  async bind(workspaceId: string, document: ProseMirrorDocument): Promise<ProseMirrorDocument> {
    const index = await this.loadIndex(workspaceId);
    return bindPageLinkIdentities(document, (title) => index.identityFor(title));
  }

  /** Rewrites every stored title from its identity, for the Markdown export. */
  async refreshTitles(
    workspaceId: string,
    document: ProseMirrorDocument,
  ): Promise<ProseMirrorDocument> {
    const index = await this.loadIndex(workspaceId);
    return resolvePageLinkTitles(document, (documentId) => index.titleFor(documentId));
  }
}
