import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type CaptureRequest,
  type CaptureResponse,
  type DocumentSummary,
  type InboxResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { DocumentContentService } from '../documents/document-content.service';
import { DOCUMENT_SELECT, type DocumentRow, toSummary } from '../documents/document-shape';
import { DocumentsService } from '../documents/documents.service';
import { PRISMA } from '../platform/platform.module';

import { buildCaptureNote } from './capture-note';

/** Title the inbox is created with. It is a page, so it can be renamed afterwards. */
const INBOX_TITLE = 'Eingang';

/** Lucide, like every other drawn page icon. */
const INBOX_ICON = 'lucide:inbox';

const INBOX_INTRO =
  'Hier landet, was schnell erfasst wurde: Gedanken, Textschnipsel, Links. ' +
  'Einträge bleiben gewöhnliche Seiten und werden von hier aus einsortiert.\n';

/**
 * The inbox, and the capture that fills it (issue #71, ADR-036).
 *
 * Nothing here is a new kind of content. A capture is `documents.create`
 * followed by `content.write`, the two paths every other page goes through, so
 * a captured note arrives in search, in the outbox, in an open editor and in
 * the activity log without anything knowing that capture exists. What this
 * service adds is a destination that does not have to be chosen.
 */
@Injectable()
export class InboxService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly access: WorkspaceAccessService,
    private readonly documents: DocumentsService,
    private readonly content: DocumentContentService,
  ) {}

  /**
   * What is waiting to be filed.
   *
   * Newest first, which is the opposite of the tree's own order: the inbox is
   * read to empty it, and the thing most likely to still be actionable is the
   * one captured a minute ago. Archived entries are left out -- an inbox that
   * counts what was already dealt with stops being a count of anything.
   */
  async read(input: {
    workspaceId: string;
    userId: string;
    limit: number;
  }): Promise<InboxResponse> {
    await this.access.requireRole(input.workspaceId, input.userId);

    const inbox = await this.loadInbox(input.workspaceId);
    if (inbox === null) return { inbox: null, items: [], itemCount: 0 };

    const [items, itemCount] = await Promise.all([
      this.prisma.document.findMany({
        where: { workspaceId: input.workspaceId, parentId: inbox.id, archivedAt: null },
        orderBy: { createdAt: 'desc' },
        take: input.limit,
        select: DOCUMENT_SELECT,
      }),
      this.prisma.document.count({
        where: { workspaceId: input.workspaceId, parentId: inbox.id, archivedAt: null },
      }),
    ]);

    return { inbox: toSummary(inbox), items: items.map(toSummary), itemCount };
  }

  /**
   * Capture: text in, page out.
   *
   * The inbox is created on the first capture rather than with the workspace,
   * so a deployment that never captures anything never grows the page, and an
   * existing workspace needs no migration to gain one.
   */
  async capture(input: {
    workspaceId: string;
    userId: string;
    request: CaptureRequest;
    correlationId: string;
  }): Promise<CaptureResponse> {
    const now = new Date();
    const note = buildCaptureNote(input.request, now);

    const target = await this.resolveTarget(input);

    const created = await this.documents.create({
      workspaceId: input.workspaceId,
      userId: input.userId,
      request: { type: 'PAGE', title: note.title, parentId: target.parent?.id ?? null },
      correlationId: input.correlationId,
    });

    // An empty note is a title and nothing else, and writing an empty body
    // would only cost a snapshot and a materialization run.
    if (note.markdown.length > 0) {
      await this.content.write({
        documentId: created.id,
        userId: input.userId,
        request: { markdown: note.markdown, mode: 'replace' },
        correlationId: input.correlationId,
        source: 'api',
        // A capture and a clip may be any size and are never split (issue #118,
        // section 10): the inbox is where things land before anybody decides.
        growth: 'exempt',
      });
    }

    this.logger.info('Captured into the inbox', {
      documentId: created.id,
      workspaceId: input.workspaceId,
      parentId: target.parent?.id ?? null,
      correlationId: input.correlationId,
      inboxCreated: target.created,
    });

    return {
      document: created,
      parent: target.parent,
      inboxCreated: target.created,
      url: this.documentUrl(input.workspaceId, created.id),
    };
  }

  /**
   * Where the capture lands: the page the caller named, or the inbox.
   *
   * A named parent is checked here rather than trusted, because `parentId` is
   * the one field of a capture that can point somewhere the caller may not
   * reach; `documents.create` would catch a foreign workspace, but the error a
   * caller gets is clearer when it names the inbox it did not get.
   */
  private async resolveTarget(input: {
    workspaceId: string;
    userId: string;
    request: CaptureRequest;
    correlationId: string;
  }): Promise<{ parent: DocumentSummary | null; created: boolean }> {
    if (input.request.parentId !== undefined) {
      const parent = await this.prisma.document.findUnique({
        where: { id: input.request.parentId },
        select: DOCUMENT_SELECT,
      });
      if (parent === null || parent.workspaceId !== input.workspaceId) {
        throw AppError.notFound('Parent document');
      }
      if (parent.archivedAt !== null) {
        throw new AppError('document_archived', 'Cannot capture into an archived page');
      }
      return { parent: toSummary(parent), created: false };
    }

    const existing = await this.loadInbox(input.workspaceId);
    if (existing !== null) return { parent: toSummary(existing), created: false };

    return this.createInbox(input);
  }

  private async loadInbox(workspaceId: string): Promise<DocumentRow | null> {
    return this.prisma.document.findFirst({
      where: { workspaceId, isInbox: true, archivedAt: null },
      select: DOCUMENT_SELECT,
    });
  }

  /**
   * Creating the inbox, once.
   *
   * Two captures arriving together both find no inbox and both try to create
   * one; the partial unique index refuses the second, and the loser reads the
   * winner's page instead of failing a capture over a race the user never
   * caused. The page is placed above the existing top-level pages because an
   * inbox that has to be scrolled to is one nobody empties.
   */
  private async createInbox(input: {
    workspaceId: string;
    userId: string;
    correlationId: string;
  }): Promise<{ parent: DocumentSummary; created: boolean }> {
    const firstRoot = await this.prisma.document.findFirst({
      where: { workspaceId: input.workspaceId, parentId: null, archivedAt: null },
      orderBy: { orderKey: 'asc' },
      select: { id: true },
    });

    try {
      const inbox = await this.documents.create({
        workspaceId: input.workspaceId,
        userId: input.userId,
        request: {
          type: 'PAGE',
          title: INBOX_TITLE,
          icon: INBOX_ICON,
          iconColor: 'yellow',
          beforeSiblingId: firstRoot?.id ?? null,
        },
        correlationId: input.correlationId,
        isInbox: true,
      });
      await this.content.write({
        documentId: inbox.id,
        userId: input.userId,
        request: { markdown: INBOX_INTRO, mode: 'replace' },
        correlationId: input.correlationId,
        source: 'api',
        growth: 'exempt',
      });
      return { parent: inbox, created: true };
    } catch (error) {
      const raced = await this.loadInbox(input.workspaceId);
      if (raced === null) throw error;
      this.logger.info('Lost the race to create the inbox; using the existing one', {
        workspaceId: input.workspaceId,
        documentId: raced.id,
        correlationId: input.correlationId,
      });
      return { parent: toSummary(raced), created: false };
    }
  }

  private documentUrl(workspaceId: string, documentId: string): string | null {
    try {
      return new URL(
        `/arbeitsbereich/${workspaceId}/seite/${documentId}`,
        this.env.APP_URL,
      ).toString();
    } catch {
      return null;
    }
  }
}
