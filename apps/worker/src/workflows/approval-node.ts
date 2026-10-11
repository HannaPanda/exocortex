import {
  type ApplicationEvent,
  type WorkflowApprovalOption,
  type WorkflowNodeOf,
} from '@exocortex/contracts';
import { type PrismaClient, raiseAttentionItems } from '@exocortex/database';
import { createCorrelationId } from '@exocortex/logger';

import { type NodeContext, type NodeHandler, type NodeOutcome } from './handlers';

/**
 * The approval node (issue #163): asks a person through an ordinary
 * attention item and waits for the answer without holding a worker.
 *
 * Nothing here is a second way to ask somebody. The question lands in "Wartet
 * auf dich" like every other, it is answered through the same route, and who
 * may answer it is the attention item's rule: its recipient, or anybody who
 * may manage work in the workspace -- and, because a workflow's gate is
 * meant for a person, never an agent or the built-in AI (the API refuses
 * those). The item remembers the attempt that raised it in
 * `workflowExecutionId`, which is unique, so a second delivery of the same
 * attempt finds the item the first one raised.
 *
 * The decision is read from the item every time the node is woken, never
 * from the job that woke it: a wake that arrives twice, or for an item that
 * is still open, changes nothing.
 */

export interface ApprovalNodeDependencies {
  prisma: PrismaClient;
  /** Tells the open inboxes a question arrived; absent in tests. */
  bus?: { publish: (event: ApplicationEvent) => Promise<void> } | null;
}

const APPROVAL_HANDLES: Readonly<Record<WorkflowApprovalOption, string>> = {
  approve: 'approved',
  reject: 'rejected',
};

const NOTE_MODE = { none: 'NONE', optional: 'OPTIONAL', required: 'REQUIRED' } as const;

export function createApprovalNodeHandler(dependencies: ApprovalNodeDependencies): NodeHandler {
  return {
    // The one side effect is keyed by the attempt: the unique
    // `workflowExecutionId` of the attention item.
    idempotent: true,
    execute: (context) => ask(dependencies, context),
    resume: (context) => settle(dependencies.prisma, context),
  };
}

async function ask(
  dependencies: ApprovalNodeDependencies,
  context: NodeContext,
): Promise<NodeOutcome> {
  const { prisma } = dependencies;
  const existing = await itemOf(prisma, context.execution.id);
  // A second delivery: the question is already asked, and maybe answered.
  if (existing !== null) return settle(prisma, context);

  const node = context.node as WorkflowNodeOf<'approval'>;
  const { run } = context;
  const raised = await raiseAttentionItems(prisma, [
    {
      workspaceId: run.workspaceId,
      kind: 'APPROVAL',
      title: node.title,
      reason: node.question,
      urgency: 'NORMAL',
      recipientId: await recipientFor(prisma, run.workspaceId, node.assigneeUserId),
      // The run acts as this person; the item names the workflow beside it.
      raisedByKind: 'HUMAN',
      raisedById: run.startedById,
      agentLabel: null,
      // Its options have an effect -- they continue the run -- and nobody
      // withdraws it but the run ending.
      system: true,
      options: [
        { id: 'approve', label: null },
        { id: 'reject', label: null },
      ],
      noteMode: NOTE_MODE[node.note],
      blocking: true,
      workflowExecutionId: context.execution.id,
    },
  ]);
  const item = await itemOf(prisma, context.execution.id);
  if (item === null) throw new Error('The approval could not be raised');
  if (raised.length > 0) {
    await dependencies.bus
      ?.publish({
        type: 'attention.changed',
        workspaceId: run.workspaceId,
        correlationId: run.correlationId ?? createCorrelationId(),
        emittedAt: new Date().toISOString(),
        payload: { attentionItemIds: raised, action: 'raised' },
      })
      .catch((error: unknown) => {
        // The item is there either way; an inbox finds it on its next read.
        context.logger.warn('Announcing a workflow approval failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
  return waitingOn(item.id);
}

/** Decides from the item as it is now. */
async function settle(prisma: PrismaClient, context: NodeContext): Promise<NodeOutcome> {
  const item = await itemOf(prisma, context.execution.id);
  if (item === null) {
    return gone('The approval this node asked for is gone');
  }
  if (item.status === 'OPEN') return waitingOn(item.id);
  if (item.status === 'OBSOLETE') {
    return gone('The approval was settled without an answer');
  }
  const resolution = recordOf(item.resolution);
  const optionId = resolution?.optionId;
  if (optionId !== 'approve' && optionId !== 'reject') {
    return gone('The approval was settled without choosing approve or reject');
  }
  const note = typeof resolution?.note === 'string' ? resolution.note : null;
  return {
    status: 'succeeded',
    handles: [APPROVAL_HANDLES[optionId]],
    output: {
      // The shape a condition and a goal read (`WORKFLOW_APPROVAL_FIELDS`).
      fields: { approved: optionId === 'approve', note },
      attentionItemId: item.id,
      answeredById: item.settledById,
      answeredAt: item.settledAt?.toISOString() ?? null,
    },
  };
}

function waitingOn(attentionItemId: string): NodeOutcome {
  return { status: 'waiting', wait: { kind: 'attention_item', attentionItemId } };
}

function gone(message: string): NodeOutcome {
  return { status: 'failed', errorClass: 'terminal', code: 'workflow_approval_gone', message };
}

async function itemOf(prisma: PrismaClient, executionId: string) {
  return prisma.attentionItem.findUnique({
    where: { workflowExecutionId: executionId },
    select: { id: true, status: true, resolution: true, settledById: true, settledAt: true },
  });
}

/**
 * The person the graph names, while they are still an active member of the
 * workspace; otherwise nobody in particular, which puts the question in the
 * inbox of everybody there who may manage work rather than nowhere.
 */
async function recipientFor(
  prisma: PrismaClient,
  workspaceId: string,
  assigneeUserId: string | null,
): Promise<string | null> {
  if (assigneeUserId === null) return null;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: assigneeUserId } },
    select: { user: { select: { disabledAt: true } } },
  });
  return member !== null && member.user.disabledAt === null ? assigneeUserId : null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
