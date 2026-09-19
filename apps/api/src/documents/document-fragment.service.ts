import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canReadDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type DocumentFragmentRequest,
  type DocumentFragmentResponse,
  type DocumentOutlineBlock,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  type CollectedTransclusion,
  collectTransclusions,
  extractBlockFragment,
  outlineBlocks,
  type ProseMirrorDocument,
  type ProseMirrorNode,
  serializeMarkdown,
  transclusionKey,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform.module';

import { toIconColor } from './documents.service';
import { PageLinkIdentityService } from './page-link-identity.service';

/**
 * Upper bound on the sources one materialized export will resolve.
 *
 * A page with more transclusions than this keeps the rest as references rather
 * than turning one export into hundreds of document reads. Far above anything
 * anyone writes by hand; it exists so a generated page cannot make an export
 * expensive.
 */
export const MAX_MATERIALIZED_TRANSCLUSIONS = 50;

/**
 * What a transclusion shows (issue #78, ADR-045).
 *
 * Two callers, one rule. The browser asks per placed block while it renders a
 * page; the Markdown export asks for all of them at once when it was told to
 * carry text instead of references. Both go through `loadFragment`, so the
 * authorization is written once: the fragment is read **as the caller**, with
 * `canReadDocument` on the source, which is what makes a transclusion of a page
 * somebody may not open show its absence rather than its content.
 *
 * Nothing here resolves a transclusion inside a fragment. One level is the rule
 * of ADR-045 and it is what makes a cycle impossible instead of detectable.
 */
@Injectable()
export class DocumentFragmentService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly pageLinks: PageLinkIdentityService,
  ) {}

  async read(
    documentId: string,
    userId: string,
    query: DocumentFragmentRequest,
  ): Promise<DocumentFragmentResponse> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const [document, content] = await Promise.all([
      this.prisma.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { title: true, icon: true, iconColor: true, archivedAt: true },
      }),
      this.prisma.documentContent.findUnique({
        where: { documentId },
        select: { yjsState: true },
      }),
    ]);
    if (content === null) throw AppError.notFound('Document content');

    // The titles references carry are refreshed the way the export refreshes
    // them (issue #14): a fragment names the pages it points at as they are
    // called now, not as they were called when somebody typed them.
    const page = await this.pageLinks.refreshTitles(
      context.workspaceId,
      yjsStateToProseMirrorJson(content.yjsState),
    );

    const blockId = query.blockId ?? null;
    const fragment = blockId === null ? page : extractBlockFragment(page, blockId);
    const resolved = fragment !== null;
    const shown: ProseMirrorDocument = fragment ?? { type: 'doc', content: [] };

    return {
      documentId,
      title: document.title,
      icon: document.icon,
      iconColor: toIconColor(document.iconColor),
      archivedAt: document.archivedAt?.toISOString() ?? null,
      blockId,
      resolved,
      markdown: serializeMarkdown(shown),
      proseMirrorJson: shown as { type: 'doc' },
      blocks: query.outline ? (outlineBlocks(page) as DocumentOutlineBlock[]) : [],
      nested: collectTransclusions(shown).length,
    };
  }

  /**
   * The blocks each of `targets` stands for, keyed by `transclusionKey`.
   *
   * A target that cannot be resolved -- no identity on the reference, a page
   * this caller may not read, a page that is gone, a block that is gone -- is
   * simply absent from the map, and the caller keeps the reference. An export
   * must not be the place where a broken reference turns into missing content.
   */
  async resolveMany(
    targets: readonly CollectedTransclusion[],
    userId: string,
    /** The page being exported. It may not embed itself into itself. */
    excludeDocumentId: string,
  ): Promise<Map<string, ProseMirrorNode[]>> {
    const wanted = new Map<string, CollectedTransclusion>();
    for (const target of targets) {
      if (target.documentId === null || target.documentId === excludeDocumentId) continue;
      const key = transclusionKey(target.documentId, target.blockId);
      if (!wanted.has(key) && wanted.size < MAX_MATERIALIZED_TRANSCLUSIONS) {
        wanted.set(key, target);
      }
    }

    const resolved = new Map<string, ProseMirrorNode[]>();
    for (const [key, target] of wanted) {
      const fragment = await this.loadFragment(target, userId);
      if (fragment !== null) resolved.set(key, fragment);
    }
    return resolved;
  }

  /** One target, read as `userId`, or `null` for anything that does not resolve. */
  private async loadFragment(
    target: CollectedTransclusion,
    userId: string,
  ): Promise<ProseMirrorNode[] | null> {
    if (target.documentId === null) return null;
    try {
      const fragment = await this.read(target.documentId, userId, {
        blockId: target.blockId ?? undefined,
        outline: false,
      });
      if (!fragment.resolved) return null;
      return (fragment.proseMirrorJson as ProseMirrorDocument).content ?? [];
    } catch {
      // A page that is gone or that this caller may not read is a reference
      // that stays a reference; it is not a reason to fail the export.
      return null;
    }
  }
}
