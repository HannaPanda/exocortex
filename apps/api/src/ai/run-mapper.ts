import { type AiRun } from '@exocortex/contracts';
import { type AiReasoningLevel as AiReasoningLevelPrisma } from '@exocortex/database';

import { REASONING_LEVEL_TO_CONTRACT } from './ai-model-resolver.service';

/** Wire status (contract) is lowercase; the Prisma enum is uppercase. */
export const AI_RUN_STATUS_TO_CONTRACT = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  TIMED_OUT: 'timed_out',
} as const;

/** Fields every `AiRun` row carries, independent of which query selected it. */
export interface AiRunRow {
  id: string;
  workspaceId: string;
  documentId: string | null;
  status: keyof typeof AI_RUN_STATUS_TO_CONTRACT;
  provider: string;
  model: string;
  createdById: string;
  createdAt: Date;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  usage: unknown;
  errorCode: string | null;
  conversationId: string | null;
  reasoningLevel: AiReasoningLevelPrisma;
  toolIterations: number;
}

/**
 * Maps an `AiRun` Prisma row onto the wire contract.
 *
 * Shared between the legacy run endpoint (`ai.service.ts`) and the
 * conversation-backed message endpoint (`conversations.service.ts`) so both
 * paths report status, reasoning level and usage identically.
 */
export function mapAiRunRow(run: AiRunRow): AiRun {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    documentId: run.documentId,
    status: AI_RUN_STATUS_TO_CONTRACT[run.status],
    provider: run.provider,
    model: run.model,
    createdById: run.createdById,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt === null ? null : run.startedAt.toISOString(),
    heartbeatAt: run.heartbeatAt === null ? null : run.heartbeatAt.toISOString(),
    finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
    usage: run.usage === null ? null : (run.usage as AiRun['usage']),
    errorCode: run.errorCode,
    conversationId: run.conversationId,
    reasoningLevel: REASONING_LEVEL_TO_CONTRACT[run.reasoningLevel],
    toolIterations: run.toolIterations,
  };
}
