import { type AiRun, DEFAULT_LOCALE, type Locale } from '@exocortex/contracts';
import { type AiReasoningLevel as AiReasoningLevelPrisma } from '@exocortex/database';
import { aiRunDiagnosisText } from '@exocortex/i18n';
import { serverTranslator } from '@exocortex/i18n/catalog';

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
  /** German diagnosis of the failure, when there is more to say than the code (issue #118). */
  errorDetail: string | null;
  /** The same diagnosis as a `diagnostics` key and its arguments (issue #98). */
  errorDetailKey: string | null;
  errorDetailArgs: unknown;
  /** Partial while the run is still going; final once it has ended (issue #6). */
  resultText: string | null;
  conversationId: string | null;
  reasoningLevel: AiReasoningLevelPrisma;
  toolIterations: number;
  toolCalls: number;
  /** See `aiRunSchema`: what the run was offered and what it weighed (issue #121). */
  toolsOffered: number | null;
  toolSchemaChars: number | null;
  toolDomains: string[];
}

/**
 * Maps an `AiRun` Prisma row onto the wire contract.
 *
 * Shared between the legacy run endpoint (`ai.service.ts`) and the
 * conversation-backed message endpoint (`conversations.service.ts`) so both
 * paths report status, reasoning level and usage identically.
 *
 * `locale` is the requester's (`readerLocale`): the diagnosis is rendered in
 * it when the row carries a key, so `exo_ai_run_get` answers in the caller's
 * language; a row without one keeps its stored German (issue #98, ADR-062).
 */
export function mapAiRunRow(run: AiRunRow, locale: Locale = DEFAULT_LOCALE): AiRun {
  const errorDetailArgs = isArgs(run.errorDetailArgs) ? run.errorDetailArgs : null;
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
    errorDetail: aiRunDiagnosisText(serverTranslator(locale, 'diagnostics'), {
      errorDetail: run.errorDetail,
      errorDetailKey: run.errorDetailKey,
      errorDetailArgs,
    }),
    errorDetailKey: run.errorDetailKey,
    errorDetailArgs,
    resultText: run.resultText,
    conversationId: run.conversationId,
    reasoningLevel: REASONING_LEVEL_TO_CONTRACT[run.reasoningLevel],
    toolIterations: run.toolIterations,
    toolCalls: run.toolCalls,
    toolsOffered: run.toolsOffered,
    toolSchemaChars: run.toolSchemaChars,
    toolDomains: run.toolDomains,
  };
}

function isArgs(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
