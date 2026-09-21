import { Inject, Injectable } from '@nestjs/common';

import {
  type BlockRangeEdit,
  type CollaborationApplyMode,
  QUEUE_NAMES,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { EXOCORTEX_SCHEMA_VERSION, type ProseMirrorDocument } from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { PRISMA, QUEUES } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import { CollaborationBridgeService } from './collaboration-bridge.service';

/**
 * Everything that happens *after* a write has been worked out (issue #111).
 *
 * Two services produce new binary state for a page now: the whole-page write
 * (`DocumentContentService`) and the narrow ones that address blocks
 * (`DocumentEditService`). What follows is identical for both and is the part
 * that is easy to get subtly wrong: the snapshot has to be written in the same
 * transaction as the content, `materializedAt` has to be left where it is, the
 * outbox entry has to name the snapshot, the open editing session has to be
 * told *after* the commit (ADR-016), and the materialization job has to be
 * enqueued whatever else happened.
 *
 * So it is written once. A second copy of this sequence is the kind of
 * duplication that stays correct for a month and then diverges in the one line
 * nobody compares.
 */
export interface DocumentWriteCommit {
  documentId: string;
  workspaceId: string;
  userId: string;
  correlationId: string;
  /** 'api' for humans, 'ai' for the built-in assistant / MCP. Recorded in the event. */
  source: 'api' | 'ai';
  /** The state this write replaces, kept as the snapshot to roll back to. */
  previous: { yjsState: Uint8Array; schemaVersion: number };
  /** The state it produced, with the two views derived from it. */
  applied: { yjsState: Uint8Array; proseMirrorJson: ProseMirrorDocument; plainText: string };
  /** The page's Markdown afterwards, for the derived column. */
  markdown: string;
  /** A title taken from the content, when the page had none. `null` otherwise. */
  promotedTitle: string | null;
  /** What the open editing session is handed, and how it is placed. */
  live: {
    mode: CollaborationApplyMode;
    proseMirrorJson: ProseMirrorDocument;
    edit?: BlockRangeEdit | null;
  };
}

export interface DocumentWriteCommitResult {
  snapshotId: string;
  yjsUpdatedAt: string;
  appliedToLiveSession: boolean;
  /** Warnings this step produced; the caller adds its own. */
  warnings: string[];
}

@Injectable()
export class DocumentWriteCommitService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
    private readonly collaboration: CollaborationBridgeService,
  ) {}

  async commit(input: DocumentWriteCommit): Promise<DocumentWriteCommitResult> {
    const warnings: string[] = [];
    const now = new Date();

    const { snapshotId } = await this.prisma.$transaction(async (tx) => {
      const snapshot = await tx.documentSnapshot.create({
        data: {
          documentId: input.documentId,
          yjsState: Buffer.from(input.previous.yjsState),
          schemaVersion: input.previous.schemaVersion,
          createdById: input.userId,
          reason: 'API_WRITE',
        },
      });

      await tx.documentContent.update({
        where: { documentId: input.documentId },
        data: {
          yjsState: Buffer.from(input.applied.yjsState),
          schemaVersion: EXOCORTEX_SCHEMA_VERSION,
          yjsUpdatedAt: now,
          proseMirrorJson: input.applied.proseMirrorJson as unknown as Prisma.InputJsonObject,
          plainText: input.applied.plainText,
          markdown: input.markdown,
          /*
           * `materializedAt` is deliberately *not* moved forward here.
           *
           * These columns are written so the answer to this request is
           * consistent immediately, but they are not everything materialization
           * derives: the reference index and the comment anchors come from the
           * same content and are only produced by the job enqueued below. That
           * job skips a document whose `materializedAt` has caught up with its
           * `yjsUpdatedAt`, so stamping it here would have it decide there is
           * nothing to do -- and every write through the API or MCP would leave
           * the references of the page it just rewrote exactly as they were.
           */
        },
      });

      await tx.document.update({
        where: { id: input.documentId },
        data: {
          updatedById: input.userId,
          ...(input.promotedTitle === null ? {} : { title: input.promotedTitle }),
        },
      });

      await this.outbox.writeEvent(tx, {
        workspaceId: input.workspaceId,
        type: 'document.updated',
        payload: { documentId: input.documentId },
        correlationId: input.correlationId,
        // What a bulk revert of this agent's session would go back to
        // (ADR-022). The snapshot exists either way; naming it here is what
        // turns "an agent wrote here" into "and here is the way back".
        snapshotBeforeId: snapshot.id,
      });

      return { snapshotId: snapshot.id };
    });

    // Only now, with the snapshot safely committed, is the change handed to the
    // open session: if the transaction had failed, nothing may have reached the
    // editors either.
    const live = await this.collaboration.applyToLiveSession({
      documentId: input.documentId,
      userId: input.userId,
      mode: input.live.mode,
      proseMirrorJson: input.live.proseMirrorJson,
      edit: input.live.edit ?? null,
      correlationId: input.correlationId,
    });
    if (!live.reachable) {
      warnings.push(
        'Der Live-Editor konnte nicht benachrichtigt werden. Wer die Seite gerade offen hat, ' +
          'muss sie neu laden, sonst überschreibt die offene Sitzung diese Änderung.',
      );
    }

    await this.realtime.emit('document.content.replaced', input.workspaceId, input.correlationId, {
      documentId: input.documentId,
      snapshotId,
      source: input.source,
    });

    // Re-materialize so every derived field is produced by exactly one code path.
    await this.queues.enqueue(QUEUE_NAMES.documentMaterialization, {
      correlationId: input.correlationId,
      documentId: input.documentId,
      workspaceId: input.workspaceId,
      yjsUpdatedAt: Date.now(),
      reason: 'manual',
    });

    this.logger.info('Document content written', {
      documentId: input.documentId,
      mode: input.live.edit === null || input.live.edit === undefined ? input.live.mode : 'range',
      byteSize: input.applied.yjsState.byteLength,
      snapshotId,
      appliedToLiveSession: live.applied,
      correlationId: input.correlationId,
    });

    return {
      snapshotId,
      // When a live session took the change, that session's own store is the
      // last write, so its timestamp is the one a caller must send back as
      // `expectedYjsUpdatedAt` on the next write.
      yjsUpdatedAt: live.yjsUpdatedAt ?? now.toISOString(),
      appliedToLiveSession: live.applied,
      warnings,
    };
  }
}
