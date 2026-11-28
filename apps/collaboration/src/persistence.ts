import { QUEUE_NAMES } from '@exocortex/contracts';
import { Prisma, type PrismaClient } from '@exocortex/database';
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
   *
   * `typistId` is the account whose typing this store carries (`typist.ts`).
   * It is recorded beside the state so a version sampled from it later names
   * its author (issue #235); `null` leaves the recorded one alone, because a
   * write that did not come from a connection is not somebody's typing.
   */
  async store(input: {
    documentId: string;
    state: Uint8Array;
    typistId?: string | null;
  }): Promise<void> {
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
    const write = (typist: { yjsUpdatedById?: string }) =>
      this.prisma.documentContent.upsert({
        where: { documentId: input.documentId },
        create: {
          documentId: input.documentId,
          yjsState: state,
          schemaVersion: EXOCORTEX_SCHEMA_VERSION,
          yjsUpdatedAt: now,
          ...typist,
        },
        update: {
          yjsState: state,
          yjsUpdatedAt: now,
          schemaVersion: EXOCORTEX_SCHEMA_VERSION,
          ...typist,
        },
      });

    const typistId = input.typistId ?? null;
    try {
      await write(typistId === null ? {} : { yjsUpdatedById: typistId });
    } catch (error) {
      // An account deleted while its connection was still open fails the
      // foreign key. The name is a courtesy, the state is not: store it
      // without one rather than lose what was typed.
      if (typistId === null || !isForeignKeyFailure(error)) throw error;
      this.logger.warn('Stored a state without its typist, whose account is gone', {
        documentId: input.documentId,
      });
      await write({});
    }

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

function isForeignKeyFailure(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}
