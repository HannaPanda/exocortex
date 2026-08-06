import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canReadDocument,
  canRestoreSnapshot,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type DocumentSnapshot, QUEUE_NAMES } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { EXOCORTEX_SCHEMA_VERSION, yjsStateToProseMirrorJson } from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';
import { QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { PRISMA, QUEUES } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';

import { CollaborationBridgeService } from './collaboration-bridge.service';
import { toSummary } from './documents.service';

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
 * Snapshots store the binary Yjs state verbatim, so restoring one is a byte-level
 * operation and never a lossy re-parse. A full version-history UI is out of scope
 * for this version; the services below are what it will be built on.
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
    });

    return {
      id: snapshot.id,
      documentId: snapshot.documentId,
      schemaVersion: snapshot.schemaVersion,
      createdById: snapshot.createdById,
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
      },
    });

    return snapshots.map((snapshot) => ({
      id: snapshot.id,
      documentId: snapshot.documentId,
      schemaVersion: snapshot.schemaVersion,
      createdById: snapshot.createdById,
      reason: REASON_MAP[snapshot.reason],
      createdAt: snapshot.createdAt.toISOString(),
      byteSize: snapshot.yjsState.byteLength,
    }));
  }

  /**
   * Restores a snapshot:
   *  1. verify permission
   *  2. snapshot the current state (safety net)
   *  3. write back the binary Yjs state
   *  4. push the restored content into an open editing session (ADR-016)
   *  5. trigger materialization
   *  6. notify connected clients
   *  7. write an audit entry
   *
   * Step 4 is what makes a restore hold: a session that has the page open keeps
   * the version it is showing in memory and would autosave it back over the
   * restored one.
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

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.documentContent.findUnique({
        where: { documentId: snapshot.documentId },
        select: { yjsState: true, schemaVersion: true },
      });
      if (current === null) throw AppError.notFound('Document content');

      await tx.documentSnapshot.create({
        data: {
          documentId: snapshot.documentId,
          yjsState: current.yjsState,
          schemaVersion: current.schemaVersion,
          createdById: input.userId,
          reason: 'PRE_RESTORE',
        },
      });

      await tx.documentContent.update({
        where: { documentId: snapshot.documentId },
        data: {
          yjsState: snapshot.yjsState,
          schemaVersion: snapshot.schemaVersion,
          yjsUpdatedAt: new Date(),
          materializedAt: null,
        },
      });

      await this.outbox.writeAudit(tx, {
        workspaceId: context.workspaceId,
        actorId: input.userId,
        action: 'document.snapshot_restored',
        targetType: 'document_snapshot',
        targetId: snapshot.id,
        correlationId: input.correlationId,
        metadata: { documentId: snapshot.documentId },
      });
      await this.outbox.writeEvent(tx, {
        workspaceId: context.workspaceId,
        type: 'document.updated',
        payload: { documentId: snapshot.documentId },
        correlationId: input.correlationId,
      });
    });

    const live = await this.collaboration.applyToLiveSession({
      documentId: snapshot.documentId,
      userId: input.userId,
      mode: 'replace',
      proseMirrorJson: yjsStateToProseMirrorJson(snapshot.yjsState),
      correlationId: input.correlationId,
    });

    await this.queues.enqueue(QUEUE_NAMES.documentMaterialization, {
      correlationId: input.correlationId,
      documentId: snapshot.documentId,
      workspaceId: context.workspaceId,
      yjsUpdatedAt: Date.now(),
      reason: 'restore',
    });

    const document = await this.prisma.document.findUniqueOrThrow({
      where: { id: snapshot.documentId },
      select: {
        id: true,
        workspaceId: true,
        parentId: true,
        type: true,
        title: true,
        icon: true,
        orderKey: true,
        createdById: true,
        updatedById: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
      },
    });
    await this.realtime.emit('document.updated', context.workspaceId, input.correlationId, {
      document: toSummary(document),
    });

    this.logger.warn('Document snapshot restored', {
      documentId: snapshot.documentId,
      snapshotId: snapshot.id,
      correlationId: input.correlationId,
      appliedToLiveSession: live.applied,
      schemaVersion: snapshot.schemaVersion === EXOCORTEX_SCHEMA_VERSION ? 'current' : 'legacy',
    });

    return { documentId: snapshot.documentId, restoredFrom: snapshot.id };
  }
}
