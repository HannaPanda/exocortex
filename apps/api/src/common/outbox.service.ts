import { Inject, Injectable } from '@nestjs/common';

import { type ApplicationEvent, type ApplicationEventType } from '@exocortex/contracts';
import { type Prisma, type PrismaClient, type PrismaTransactionClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { PRISMA } from '../platform/platform.module';

import { LOGGER } from './logger.provider';

/** Actions recorded in the audit log. English identifiers, snake_case. */
export const AUDIT_ACTIONS = [
  'document.archived',
  'document.restored',
  'document.moved',
  'document.snapshot_restored',
  'attachment.deleted',
  'workspace.member_role_changed',
  'workspace.member_removed',
  'workspace.deleted',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface WriteAuditInput {
  workspaceId: string;
  actorId: string | null;
  action: AuditAction;
  targetType: 'document' | 'attachment' | 'workspace' | 'workspace_member' | 'document_snapshot';
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
}

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
