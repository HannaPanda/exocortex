import { Inject, Injectable } from '@nestjs/common';

import { type ApplicationEvent, type ApplicationEventType } from '@exocortex/contracts';
import { type Prisma, type PrismaClient, type PrismaTransactionClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { PRISMA } from '../platform/platform-tokens';

import { currentAgentSession, getRequestContext } from './correlation';
import { LOGGER } from './logger.provider';

/** Actions recorded in the audit log. English identifiers, snake_case. */
export const AUDIT_ACTIONS = [
  'document.archived',
  'document.restored',
  /**
   * Deleted for good. The page it names no longer exists, which is exactly why
   * this entry has to: the audit log is the only place the deletion survives.
   */
  'document.deleted',
  'document.moved',
  'document.moved_workspace',
  'document.renamed',
  'document.snapshot_restored',
  'attachment.deleted',
  'workspace.renamed',
  'workspace.member_role_changed',
  'workspace.member_removed',
  'workspace.member_invited',
  'workspace.member_joined',
  'workspace.deleted',
  'database.property.deleted',
  'setting.updated',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface WriteAuditInput {
  workspaceId: string;
  actorId: string | null;
  action: AuditAction;
  targetType:
    | 'document'
    | 'attachment'
    | 'workspace'
    | 'workspace_member'
    | 'document_snapshot'
    | 'database_property'
    | 'setting'
    | 'invitation';
  targetId: string;
  correlationId: string;
  /**
   * Small, non-sensitive metadata only. Document contents and secrets must never
   * be written here (docs/security.md).
   */
  metadata?: Record<string, string | number | boolean | null>;
}

export interface WriteOutboxInput {
  workspaceId: string;
  type: ApplicationEventType;
  payload: Record<string, unknown>;
  correlationId: string;
  /**
   * The snapshot holding the state *before* this write, for the agent write
   * journal (ADR-022). Passed by the three services that take one; a mutation
   * that snapshots nothing leaves it unset and is recorded as not revertable,
   * which is the honest answer rather than a guess at an older snapshot.
   */
  snapshotBeforeId?: string;
}

/**
 * Events that name a page a bulk revert could act on.
 *
 * Not every event: a materialization or a job progress report is something the
 * system did to a page, not something an agent did to it, and a journal full
 * of those would bury the writes it exists to show.
 */
const JOURNALLED_EVENT_TYPES = new Set<ApplicationEventType>([
  'document.created',
  'document.updated',
  'document.content.replaced',
  'document.moved',
  'document.archived',
  'document.restored',
  'document.deleted',
]);

/**
 * Transactional outbox and audit log.
 *
 * Both writes always happen inside the same transaction as the state change they
 * describe, so an event can never be lost and an audit entry can never exist for
 * a rolled-back operation. This is deliberately *not* a generic event-sourcing
 * framework (ADR-010).
 */
@Injectable()
export class OutboxService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Writes an outbox row inside an existing transaction. */
  async writeEvent(tx: PrismaTransactionClient, input: WriteOutboxInput): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        workspaceId: input.workspaceId,
        type: input.type,
        payload: input.payload as Prisma.InputJsonObject,
        correlationId: input.correlationId,
      },
    });
    await this.writeAgentJournal(tx, input);
  }

  /**
   * Records the write against the agent session that made it (ADR-022).
   *
   * Hung off the outbox rather than given a call of its own at every mutation
   * site: the events already pass through here in full, inside the very
   * transaction that changed the data, so the journal costs no second write
   * path and can never disagree with what actually happened.
   *
   * Silent in three cases, all of them "there is nothing to group": no agent
   * session named the connection, no user is attached to the request, or the
   * event is not about one page.
   */
  private async writeAgentJournal(
    tx: PrismaTransactionClient,
    input: WriteOutboxInput,
  ): Promise<void> {
    const agent = currentAgentSession();
    const actorId = getRequestContext()?.userId;
    if (agent === undefined || actorId === undefined) return;
    if (!JOURNALLED_EVENT_TYPES.has(input.type)) return;
    const documentId = input.payload.documentId;
    if (typeof documentId !== 'string') return;

    // The title is copied, not referenced: a page deleted for good still has
    // to have a name in the list of what was done to it.
    const document = await tx.document.findUnique({
      where: { id: documentId },
      select: { title: true },
    });

    const session = await tx.agentSession.upsert({
      where: { userId_externalId: { userId: actorId, externalId: agent.externalId } },
      // Created here as well as at `initialize`, because a connection that
      // never announced itself -- the built-in AI's tool loop has no handshake
      // -- still writes, and an unannounced write is exactly the one somebody
      // will want back.
      create: {
        externalId: agent.externalId,
        userId: actorId,
        clientLabel: agent.clientLabel ?? null,
      },
      update: { lastSeenAt: new Date() },
      select: { id: true },
    });

    await tx.agentWriteJournal.create({
      data: {
        sessionId: session.id,
        workspaceId: input.workspaceId,
        documentId,
        documentTitle: document?.title ?? null,
        actorId,
        action: input.type,
        snapshotBeforeId: input.snapshotBeforeId ?? null,
        correlationId: input.correlationId,
      },
    });
  }

  /** Writes an audit entry inside an existing transaction. */
  async writeAudit(tx: PrismaTransactionClient, input: WriteAuditInput): Promise<void> {
    await tx.auditLog.create({
      data: {
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        correlationId: input.correlationId,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonObject,
      },
    });
  }

  /** Reads recent audit entries. Used by tests and future admin views. */
  async listAudit(workspaceId: string, limit = 50) {
    return this.prisma.auditLog.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** Number of outbox rows still waiting for dispatch. Used by health checks. */
  async pendingOutboxCount(): Promise<number> {
    return this.prisma.outboxEvent.count({ where: { processedAt: null } });
  }

  logDispatched(event: ApplicationEvent): void {
    this.logger.debug('Domain event dispatched', {
      type: event.type,
      workspaceId: event.workspaceId,
      correlationId: event.correlationId,
    });
  }
}
