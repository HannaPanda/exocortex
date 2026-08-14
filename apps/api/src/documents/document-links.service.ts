import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canReadDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type DocumentLinkEndpoint,
  type DocumentLinkKind,
  type DocumentLinksResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { PRISMA } from '../platform/platform.module';

import { toIconColor } from './documents.service';

/** Database enum to the contract's camelCase kind. */
const KIND_TO_CONTRACT = {
  PAGE_LINK: 'pageLink',
  MENTION: 'mention',
  WIKI_MARK: 'wikiMark',
} as const satisfies Record<string, DocumentLinkKind>;

/** Columns every endpoint of a reference is rendered from. */
const ENDPOINT_SELECT = {
  id: true,
  workspaceId: true,
  title: true,
  type: true,
  icon: true,
  iconColor: true,
  archivedAt: true,
} as const;

interface EndpointRow {
  id: string;
  workspaceId: string;
  title: string;
  type: 'PAGE' | 'COLLECTION';
  icon: string | null;
  iconColor: string | null;
  archivedAt: Date | null;
}

function toEndpoint(row: EndpointRow): DocumentLinkEndpoint {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    icon: row.icon,
    iconColor: toIconColor(row.iconColor),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/**
 * Reads the reference index (issue #19).
 *
 * The index itself is written by the worker during materialization; this
 * service only reads it, and its whole job on top of that is authorization:
 * a reference is a piece of another page's content, so it may only be shown to
 * someone who is allowed to read that page.
 */
@Injectable()
export class DocumentLinksService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
  ) {}

  async list(documentId: string, userId: string): Promise<DocumentLinksResponse> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const [incomingRows, outgoingRows, content] = await Promise.all([
      this.prisma.documentLink.findMany({
        // Membership in the workspace is what grants read access to its pages
        // (`canReadDocument`), so scoping the query to this workspace is the
        // authorization: a reference whose source the caller may not read can
        // never be in the result, and a row left over from a page that has
        // since moved to another workspace is excluded by the same clause.
        where: {
          targetDocumentId: documentId,
          sourceDocument: { workspaceId: context.workspaceId },
        },
        select: {
          id: true,
          kind: true,
          targetTitle: true,
          blockId: true,
          context: true,
          position: true,
          sourceDocument: { select: ENDPOINT_SELECT },
        },
        orderBy: [{ sourceDocumentId: 'asc' }, { position: 'asc' }],
        take: 200,
      }),
      this.prisma.documentLink.findMany({
        where: { sourceDocumentId: documentId },
        select: {
          id: true,
          kind: true,
          targetTitle: true,
          blockId: true,
          context: true,
          position: true,
          targetDocument: { select: ENDPOINT_SELECT },
        },
        orderBy: { position: 'asc' },
        take: 200,
      }),
      this.prisma.documentContent.findUnique({
        where: { documentId },
        select: { linksIndexedAt: true },
      }),
    ]);

    return {
      documentId,
      incoming: incomingRows.map((row) => ({
        id: row.id,
        kind: KIND_TO_CONTRACT[row.kind],
        targetTitle: row.targetTitle,
        blockId: row.blockId,
        context: row.context,
        source: toEndpoint(row.sourceDocument),
      })),
      outgoing: outgoingRows.map((row) => ({
        id: row.id,
        kind: KIND_TO_CONTRACT[row.kind],
        targetTitle: row.targetTitle,
        blockId: row.blockId,
        context: row.context,
        // A target in a different workspace cannot be reached by this reader,
        // so it is reported as unresolved rather than as a page they cannot open.
        target:
          row.targetDocument !== null && row.targetDocument.workspaceId === context.workspaceId
            ? toEndpoint(row.targetDocument)
            : null,
      })),
      pending: content === null || content.linksIndexedAt === null,
    };
  }
}
