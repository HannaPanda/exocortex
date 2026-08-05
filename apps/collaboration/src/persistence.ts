import { QUEUE_NAMES } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { EXOCORTEX_SCHEMA_VERSION } from '@exocortex/editor';
import { createCorrelationId, type Logger } from '@exocortex/logger';
import { MATERIALIZATION_DEBOUNCE_MS, type QueueRegistry } from '@exocortex/queue';

export interface DocumentPersistenceOptions {
  prisma: PrismaClient;
  queues: QueueRegistry;
  logger: Logger;
}

/**
 * Binary Yjs persistence for Hocuspocus.
 *
 * `yjsState` is the canonical representation: it is stored and loaded byte for
 * byte and never reconstructed from the derived ProseMirror JSON (ADR-005).
 */
export class DocumentPersistence {
  private readonly prisma: PrismaClient;
  private readonly queues: QueueRegistry;
  private readonly logger: Logger;

  constructor(options: DocumentPersistenceOptions) {
    this.prisma = options.prisma;
    this.queues = options.queues;
    this.logger = options.logger.child({ component: 'document-persistence' });
  }

  /** Loads the exact stored binary state, or `null` for a fresh document. */
  async fetch(documentId: string): Promise<Uint8Array | null> {
    const content = await this.prisma.documentContent.findUnique({
      where: { documentId },
      select: { yjsState: true },
    });
    if (content === null) {
      this.logger.debug('No stored Yjs state, starting empty', { documentId });
      return null;
    }
    // Prisma returns a Buffer, which is a Uint8Array; pass it through unchanged.
    return content.yjsState;
  }

  /**
   * Persists the binary state and enqueues a debounced materialization job.
   *
   * The write and the enqueue are separate on purpose: materialization is
   * expensive and must never block the collaboration hot path.
   */
  async store(input: { documentId: string; state: Uint8Array }): Promise<void> {
    const now = new Date();
    const document = await this.prisma.document.findUnique({
      where: { id: input.documentId },
      select: { id: true, workspaceId: true, archivedAt: true },
    });

    if (document === null) {
      this.logger.warn('Refusing to store state for an unknown document', {
        documentId: input.documentId,
      });
      return;
    }

    if (document.archivedAt !== null) {
      // Archived documents are read-only; a write here means a client bypassed
      // the read-only connection flag.
      this.logger.warn('Refusing to store state for an archived document', {
        documentId: input.documentId,
      });
      return;
    }

    const state = Buffer.from(input.state);

    await this.prisma.documentContent.upsert({
      where: { documentId: input.documentId },
      create: {
        documentId: input.documentId,
        yjsState: state,
        schemaVersion: EXOCORTEX_SCHEMA_VERSION,
        yjsUpdatedAt: now,
      },
      update: {
        yjsState: state,
        yjsUpdatedAt: now,
        schemaVersion: EXOCORTEX_SCHEMA_VERSION,
      },
    });

    this.logger.debug('Stored binary Yjs state', {
      documentId: input.documentId,
      byteSize: state.byteLength,
    });

    await this.queues.enqueueDebounced(
      QUEUE_NAMES.documentMaterialization,
      {
        correlationId: createCorrelationId(),
        documentId: input.documentId,
        workspaceId: document.workspaceId,
        yjsUpdatedAt: now.getTime(),
        reason: 'collaboration_store',
      },
      {
        // BullMQ rejects custom job ids containing ":".
        jobId: `materialize-${input.documentId}`,
        delayMs: MATERIALIZATION_DEBOUNCE_MS,
      },
    );
  }
}
