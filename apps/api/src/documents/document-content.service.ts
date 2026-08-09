import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canEditDocument, WorkspaceAccessService } from '@exocortex/auth';
import {
  type DocumentContentWriteRequest,
  type DocumentContentWriteResponse,
  QUEUE_NAMES,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import {
  bindPageLinkIdentities,
  EXOCORTEX_SCHEMA_VERSION,
  markdownToYjsState,
  parseMarkdown,
  type ProseMirrorDocument,
  type ProseMirrorNode,
  resolvePageLinkTitles,
  serializeMarkdown,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { PRISMA, QUEUES } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import { CollaborationBridgeService } from './collaboration-bridge.service';
import { PageLinkIdentityService } from './page-link-identity.service';

/** Depth-first search for a `databaseEmbed` node (D8, mirrors collectImageSources). */
function containsDatabaseEmbed(node: ProseMirrorNode | null | undefined): boolean {
  if (node === null || node === undefined) return false;
  if (node.type === 'databaseEmbed') return true;
  return (node.content ?? []).some((child) => containsDatabaseEmbed(child));
}

/**
 * Writes Markdown into an existing document's canonical Yjs state (D8).
 *
 * Used by humans through `POST /api/documents/:id/content` and by the built-in
 * AI / MCP tools (`source: 'ai'`). Every write snapshots the previous state
 * first, so it is always revertable, and refuses to lose a `databaseEmbed`
 * reference silently (R6).
 *
 * The write lands in the database, and then — because a page somebody has open
 * is served from the collaboration server's memory, not from the database — the
 * same change is handed to that server so the open session carries it too
 * (ADR-016). Without that second step the change would be invisible until a
 * reload, and the session's next autosave would write its stale copy back over
 * it.
 */
@Injectable()
export class DocumentContentService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
    private readonly collaboration: CollaborationBridgeService,
    private readonly pageLinks: PageLinkIdentityService,
  ) {}

  async write(input: {
    documentId: string;
    userId: string;
    request: DocumentContentWriteRequest;
    correlationId: string;
    /** 'api' for humans, 'ai' for the built-in assistant / MCP. Recorded in the event. */
    source: 'api' | 'ai';
  }): Promise<DocumentContentWriteResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));

    const existing = await this.prisma.documentContent.findUnique({
      where: { documentId: input.documentId },
      select: { yjsState: true, schemaVersion: true, yjsUpdatedAt: true, proseMirrorJson: true },
    });
    if (existing === null) throw AppError.notFound('Document content');

    if (
      input.request.expectedYjsUpdatedAt !== undefined &&
      input.request.expectedYjsUpdatedAt !== existing.yjsUpdatedAt.toISOString()
    ) {
      throw new AppError(
        'document_content_conflict',
        'The document changed since it was last read',
      );
    }

    const hasEmbed = containsDatabaseEmbed(existing.proseMirrorJson as ProseMirrorNode | null);
    const warnings: string[] = [];

    if (input.request.mode !== 'replace' && hasEmbed) {
      throw new AppError(
        'document_content_lossy',
        'Appending would drop the database embeds on this page',
      );
    }
    if (input.request.mode === 'replace' && hasEmbed) {
      warnings.push('Die Seite enthielt eingebettete Datenbanken; diese wurden ersetzt.');
    }

    /*
     * A write goes through Markdown, and Markdown carries no identities: every
     * reference on the page is written as `[[Titel]]` and read back in. Both
     * halves therefore run through the identity index (issue #14) — the
     * existing content is serialized from the titles its targets carry *now*,
     * so the titles that go out are the titles that come back and bind to the
     * same pages. Without that, appending a paragraph would silently strip the
     * identity from every reference already on the page.
     */
    const identities = await this.pageLinks.loadIndex(context.workspaceId);
    const currentMarkdown = serializeMarkdown(
      resolvePageLinkTitles(yjsStateToProseMirrorJson(existing.yjsState), (documentId) =>
        identities.titleFor(documentId),
      ),
    );
    const effectiveMarkdown =
      input.request.mode === 'replace'
        ? input.request.markdown
        : input.request.mode === 'append'
          ? `${currentMarkdown}\n\n${input.request.markdown}`
          : `${input.request.markdown}\n\n${currentMarkdown}`;

    let imported: ReturnType<typeof markdownToYjsState>;
    /**
     * What an open session has to be told. For `replace` that is the finished
     * document; for `append` and `prepend` it is only the incoming Markdown, so
     * the session inserts those nodes instead of rewriting a fragment somebody
     * may be typing in right now.
     */
    let liveUpdate: ProseMirrorDocument;
    try {
      const bind = (document: ProseMirrorDocument): ProseMirrorDocument =>
        bindPageLinkIdentities(document, (title) => identities.identityFor(title));
      imported = markdownToYjsState(effectiveMarkdown, { transformDocument: bind });
      liveUpdate =
        input.request.mode === 'replace'
          ? imported.proseMirrorJson
          : bind(parseMarkdown(input.request.markdown).document);
    } catch (error) {
      this.logger.warn('Document content write rejected: markdown could not be parsed', {
        documentId: input.documentId,
        correlationId: input.correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw AppError.validation('The Markdown document could not be parsed');
    }

    const now = new Date();
    const { snapshotId } = await this.prisma.$transaction(async (tx) => {
      const snapshot = await tx.documentSnapshot.create({
        data: {
          documentId: input.documentId,
          yjsState: existing.yjsState,
          schemaVersion: existing.schemaVersion,
          createdById: input.userId,
          reason: 'API_WRITE',
        },
      });

      await tx.documentContent.update({
        where: { documentId: input.documentId },
        data: {
          yjsState: Buffer.from(imported.yjsState),
          schemaVersion: EXOCORTEX_SCHEMA_VERSION,
          yjsUpdatedAt: now,
          proseMirrorJson: imported.proseMirrorJson as unknown as Prisma.InputJsonObject,
          plainText: imported.plainText,
          markdown: effectiveMarkdown,
          materializedAt: now,
        },
      });

      await tx.document.update({
        where: { id: input.documentId },
        data: { updatedById: input.userId },
      });

      await this.outbox.writeEvent(tx, {
        workspaceId: context.workspaceId,
        type: 'document.updated',
        payload: { documentId: input.documentId },
        correlationId: input.correlationId,
      });

      return { snapshotId: snapshot.id };
    });

    // Only now, with the snapshot safely committed, is the change handed to the
    // open session: if the transaction had failed, nothing may have reached the
    // editors either.
    const live = await this.collaboration.applyToLiveSession({
      documentId: input.documentId,
      userId: input.userId,
      mode: input.request.mode,
      proseMirrorJson: liveUpdate,
      correlationId: input.correlationId,
    });
    if (!live.reachable) {
      warnings.push(
        'Der Live-Editor konnte nicht benachrichtigt werden. Wer die Seite gerade offen hat, ' +
          'muss sie neu laden, sonst überschreibt die offene Sitzung diese Änderung.',
      );
    }

    await this.realtime.emit(
      'document.content.replaced',
      context.workspaceId,
      input.correlationId,
      { documentId: input.documentId, snapshotId, source: input.source },
    );

    // Re-materialize so every derived field is produced by exactly one code path.
    await this.queues.enqueue(QUEUE_NAMES.documentMaterialization, {
      correlationId: input.correlationId,
      documentId: input.documentId,
      workspaceId: context.workspaceId,
      yjsUpdatedAt: Date.now(),
      reason: 'manual',
    });

    this.logger.info('Document content written', {
      documentId: input.documentId,
      mode: input.request.mode,
      byteSize: imported.yjsState.byteLength,
      snapshotId,
      appliedToLiveSession: live.applied,
      correlationId: input.correlationId,
    });

    return {
      documentId: input.documentId,
      snapshotId,
      // When a live session took the change, that session's own store is the
      // last write, so its timestamp is the one a caller must send back as
      // `expectedYjsUpdatedAt` on the next write.
      yjsUpdatedAt: live.yjsUpdatedAt ?? now.toISOString(),
      schemaVersion: EXOCORTEX_SCHEMA_VERSION,
      byteSize: imported.yjsState.byteLength,
      appliedToLiveSession: live.applied,
      warnings,
    };
  }
}
