import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canReadDocument,
  canRestoreSnapshot,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type DocumentSnapshot, QUEUE_NAMES } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  applyProseMirrorDocumentToState,
  EXOCORTEX_SCHEMA_VERSION,
  type ProseMirrorDocument,
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
import { DOCUMENT_SELECT, toSummary } from './documents.service';

const REASON_MAP = {
  MANUAL: 'manual',
  SCHEDULED: 'scheduled',
  PRE_RESTORE: 'pre_restore',
  IMPORT: 'import',
  RESTORE: 'restore',
  API_WRITE: 'api_write',
} as const;

/**
 * Snapshot lifecycle.
 *
 * Snapshots store the binary Yjs state verbatim, so what a restore puts back is
 * exact. It puts it back as an edit rather than as bytes, for the reason in
 * `restore`. A full version-history UI is out of scope for this version; the
 * services below are what it will be built on.
 */
@Injectable()
export class DocumentSnapshotService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly outbox: OutboxService,
    private readonly realtime: RealtimeService,
    private readonly collaboration: CollaborationBridgeService,
  ) {}

  async create(input: {
    documentId: string;
    userId: string;
    reason: 'manual';
  }): Promise<DocumentSnapshot> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const content = await this.prisma.documentContent.findUnique({
      where: { documentId: input.documentId },
      select: { yjsState: true, schemaVersion: true },
    });
    if (content === null) throw AppError.notFound('Document content');

    const snapshot = await this.prisma.documentSnapshot.create({
      data: {
        documentId: input.documentId,
        yjsState: content.yjsState,
        schemaVersion: content.schemaVersion,
        createdById: input.userId,
        reason: 'MANUAL',
      },
      select: {
        id: true,
        documentId: true,
        schemaVersion: true,
        createdById: true,
        reason: true,
        createdAt: true,
        yjsState: true,
        createdBy: { select: { name: true } },
      },
    });

    return {
      id: snapshot.id,
      documentId: snapshot.documentId,
      schemaVersion: snapshot.schemaVersion,
      createdById: snapshot.createdById,
      createdByName: snapshot.createdBy?.name ?? null,
      reason: REASON_MAP[snapshot.reason],
      createdAt: snapshot.createdAt.toISOString(),
      byteSize: snapshot.yjsState.byteLength,
    };
  }

  /** Metadata only: snapshot payloads are never sent to clients. */
  async list(documentId: string, userId: string): Promise<DocumentSnapshot[]> {
    const context = await this.access.requireDocumentContext(documentId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));

    const snapshots = await this.prisma.documentSnapshot.findMany({
      where: { documentId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        documentId: true,
        schemaVersion: true,
        createdById: true,
        reason: true,
        createdAt: true,
        yjsState: true,
        createdBy: { select: { name: true } },
      },
    });

    return snapshots.map((snapshot) => ({
      id: snapshot.id,
      documentId: snapshot.documentId,
      schemaVersion: snapshot.schemaVersion,
      createdById: snapshot.createdById,
      createdByName: snapshot.createdBy?.name ?? null,
      reason: REASON_MAP[snapshot.reason],
      createdAt: snapshot.createdAt.toISOString(),
      byteSize: snapshot.yjsState.byteLength,
    }));
  }

  /**
   * The state a restore stores: the snapshot's content applied to what the
   * document holds now, or the snapshot's bytes when that is not possible.
   *
   * See `restore` for why the edit is the one that holds. The fallback covers
   * a snapshot from an older schema, whose content may have nodes this schema
   * no longer knows, and a state that cannot be derived at all -- in both cases
   * putting the bytes back is the restore that is still available.
   */
  private restoredState(input: {
    snapshot: { id: string; documentId: string; yjsState: Uint8Array; schemaVersion: number };
    currentState: Uint8Array;
    correlationId: string;
  }): {
    yjsState: Uint8Array;
    schemaVersion: number;
    asEdit: boolean;
    /** What an open session is handed, `null` when the content did not derive. */
    content: ProseMirrorDocument | null;
  } {
    const { snapshot } = input;
    const bytes = {
      yjsState: snapshot.yjsState,
      schemaVersion: snapshot.schemaVersion,
      asEdit: false,
      content: null,
    };
    if (snapshot.schemaVersion !== EXOCORTEX_SCHEMA_VERSION) {
      this.logger.warn('Restoring a snapshot from an older schema byte for byte', {
        documentId: snapshot.documentId,
        snapshotId: snapshot.id,
        snapshotSchemaVersion: snapshot.schemaVersion,
        correlationId: input.correlationId,
      });
      return bytes;
    }
    try {
      const content = yjsStateToProseMirrorJson(snapshot.yjsState);
      const applied = applyProseMirrorDocumentToState(input.currentState, content, 'replace');
      return {
        yjsState: applied.yjsState,
        schemaVersion: EXOCORTEX_SCHEMA_VERSION,
        asEdit: true,
        content,
      };
    } catch (error) {
      this.logger.warn('Restoring a snapshot byte for byte: its content did not apply', {
        documentId: snapshot.documentId,
        snapshotId: snapshot.id,
        correlationId: input.correlationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return bytes;
    }
  }

  /**
   * Restores a snapshot:
   *  1. verify permission
   *  2. snapshot the current state (safety net)
   *  3. apply the snapshot's content to the stored state, as an edit
   *  4. push the restored content into an open editing session (ADR-016)
   *  5. trigger materialization
   *  6. notify connected clients
   *  7. write an audit entry
   *
   * Step 4 is what makes a restore hold against an open session: it keeps the
   * version it is showing in memory and would autosave it back over the
   * restored one.
   *
   * Step 3 is what makes it hold against everything else. Storing the
   * snapshot's bytes looks like the more faithful restore -- it is the state,
   * byte for byte -- but it moves the document *backwards*: the content written
   * since is missing from that state rather than deleted in it. Every copy that
   * still has it (a tab, its `y-indexeddb` store, a session that loaded before
   * the restore) then merges its newer content back in and the restore quietly
   * undoes itself. Applying the snapshot's content as a `replace` moves the
   * document forwards to the same text, deleting what came after, which is what
   * a late copy cannot resurrect.
   *
   * A snapshot written under an older schema is the exception: its content may
   * not parse into the current one, and a restore that cannot be expressed as
   * an edit is still better than no restore. Those fall back to the bytes.
   */
  async restore(input: {
    snapshotId: string;
    userId: string;
    correlationId: string;
  }): Promise<{ documentId: string; restoredFrom: string }> {
    const snapshot = await this.prisma.documentSnapshot.findUnique({
      where: { id: input.snapshotId },
      select: { id: true, documentId: true, yjsState: true, schemaVersion: true },
    });
    if (snapshot === null) throw AppError.notFound('Snapshot');

    const context = await this.access.requireDocumentContext(snapshot.documentId, input.userId);
    assertPolicy(canRestoreSnapshot(context.role, context.document));

    const existing = await this.prisma.documentContent.findUnique({
      where: { documentId: snapshot.documentId },
      select: { yjsState: true, schemaVersion: true },
    });
    if (existing === null) throw AppError.notFound('Document content');

    const restored = this.restoredState({
      snapshot,
      currentState: existing.yjsState,
      correlationId: input.correlationId,
    });

    const live = await this.commitRestore({
      documentId: snapshot.documentId,
      workspaceId: context.workspaceId,
      userId: input.userId,
      correlationId: input.correlationId,
      currentState: existing.yjsState,
      currentSchemaVersion: existing.schemaVersion,
      nextState: restored.yjsState,
      nextSchemaVersion: restored.schemaVersion,
      liveContent: restored.content,
      auditTargetId: snapshot.id,
      auditMetadata: { documentId: snapshot.documentId },
    });

    this.logger.warn('Document snapshot restored', {
      documentId: snapshot.documentId,
      snapshotId: snapshot.id,
      correlationId: input.correlationId,
      appliedToLiveSession: live.applied,
      restoredAs: restored.asEdit ? 'edit' : 'bytes',
      schemaVersion: snapshot.schemaVersion === EXOCORTEX_SCHEMA_VERSION ? 'current' : 'legacy',
    });

    return { documentId: snapshot.documentId, restoredFrom: snapshot.id };
  }

  /**
   * Steps 2 to 6 of `restore`, shared with the partial restore of issue #77.
   *
   * It is one method rather than two because everything a restore has to get
   * right lives here: the safety-net snapshot before the write, the journal
   * entry pointing at it (ADR-022), the push into an open editing session
   * (ADR-016), materialization and the realtime notice. A second caller that
   * reimplemented the sequence would be a second chance to leave one of them
   * out.
   *
   * `liveContent` is what an open session is handed; `null` when the content
   * did not derive, in which case the session keeps showing its version until
   * the next load rather than the request failing after the state is written.
   */
  async commitRestore(input: {
    documentId: string;
    workspaceId: string;
    userId: string;
    correlationId: string;
    currentState: Uint8Array;
    currentSchemaVersion: number;
    nextState: Uint8Array;
    nextSchemaVersion: number;
    liveContent: ProseMirrorDocument | null;
    auditTargetId: string;
    auditMetadata: Record<string, string | number | boolean | null>;
  }): Promise<{ applied: boolean; snapshotBeforeId: string }> {
    const snapshotBeforeId = await this.prisma.$transaction(async (tx) => {
      const before = await tx.documentSnapshot.create({
        data: {
          documentId: input.documentId,
          yjsState: Buffer.from(input.currentState),
          schemaVersion: input.currentSchemaVersion,
          createdById: input.userId,
          reason: 'PRE_RESTORE',
        },
      });

      await tx.documentContent.update({
        where: { documentId: input.documentId },
        data: {
          yjsState: Buffer.from(input.nextState),
          schemaVersion: input.nextSchemaVersion,
          yjsUpdatedAt: new Date(),
          materializedAt: null,
        },
      });

      await this.outbox.writeAudit(tx, {
        workspaceId: input.workspaceId,
        actorId: input.userId,
        action: 'document.snapshot_restored',
        targetType: 'document_snapshot',
        targetId: input.auditTargetId,
        correlationId: input.correlationId,
        metadata: input.auditMetadata,
      });
      await this.outbox.writeEvent(tx, {
        workspaceId: input.workspaceId,
        type: 'document.updated',
        payload: { documentId: input.documentId },
        correlationId: input.correlationId,
        // A restore is itself a write an agent may have made, and the
        // safety-net snapshot above is what takes it back (ADR-022).
        snapshotBeforeId: before.id,
      });
      return before.id;
    });

    const live =
      input.liveContent === null
        ? { applied: false }
        : await this.collaboration.applyToLiveSession({
            documentId: input.documentId,
            userId: input.userId,
            mode: 'replace',
            proseMirrorJson: input.liveContent,
            correlationId: input.correlationId,
          });

    await this.queues.enqueue(QUEUE_NAMES.documentMaterialization, {
      correlationId: input.correlationId,
      documentId: input.documentId,
      workspaceId: input.workspaceId,
      yjsUpdatedAt: Date.now(),
      reason: 'restore',
    });

    const document = await this.prisma.document.findUniqueOrThrow({
      where: { id: input.documentId },
      select: DOCUMENT_SELECT,
    });
    await this.realtime.emit('document.updated', input.workspaceId, input.correlationId, {
      document: toSummary(document),
    });

    return { applied: live.applied, snapshotBeforeId };
  }
}
