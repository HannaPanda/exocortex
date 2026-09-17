import { assertPolicy, canReadWorkspace, type WorkspaceAccessService } from '@exocortex/auth';
import {
  type AiConversation,
  type AiConversationMessage,
  type AiConversationRole,
} from '@exocortex/contracts';
import {
  type AiConversationRole as AiConversationRolePrisma,
  type AiReasoningLevel as AiReasoningLevelPrisma,
  Prisma,
  type PrismaClient,
} from '@exocortex/database';

import { AppError } from '../common/app-error';

import {
  type AiModelResolverService,
  REASONING_LEVEL_TO_CONTRACT,
} from './ai-model-resolver.service';

/**
 * The shape a conversation row is read in, and the way it becomes a contract.
 *
 * Shared between the two services that answer with conversations -- the panel's
 * own CRUD and the `/chats` archive (issue #69) -- because a listing that
 * described a conversation differently from the detail view would be a second
 * truth about the same row.
 */

export const CONVERSATION_SELECT = {
  id: true,
  workspaceId: true,
  createdById: true,
  title: true,
  documentId: true,
  pageContextEnabled: true,
  modelId: true,
  reasoningLevel: true,
  visionCompanionSlug: true,
  estimatedTokens: true,
  lastMessageAt: true,
  createdAt: true,
  archivedAt: true,
  document: { select: { title: true } },
  model: { select: { slug: true, contextWindowTokens: true } },
  _count: { select: { messages: true } },
} as const;

export interface ConversationRow {
  id: string;
  workspaceId: string;
  createdById: string;
  title: string;
  documentId: string | null;
  pageContextEnabled: boolean;
  modelId: string | null;
  reasoningLevel: AiReasoningLevelPrisma;
  visionCompanionSlug: string | null;
  estimatedTokens: number;
  lastMessageAt: Date;
  createdAt: Date;
  archivedAt: Date | null;
  document: { title: string } | null;
  model: { slug: string; contextWindowTokens: number } | null;
  _count: { messages: number };
}

export interface ConversationMessageRow {
  id: string;
  conversationId: string;
  role: AiConversationRolePrisma;
  content: string;
  toolCallId: string | null;
  toolName: string | null;
  isSummary: boolean;
  supersededAt: Date | null;
  runId: string | null;
  createdAt: Date;
}

export const CONVERSATION_ROLE_TO_CONTRACT: Record<AiConversationRolePrisma, AiConversationRole> = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
};

/** How much of the first user line the list shows. */
export const PREVIEW_MAX_CHARS = 160;

function collapse(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}

/**
 * The first user line of each conversation, as one query.
 *
 * `DISTINCT ON` rather than Prisma's `distinct`, which the client applies in
 * memory: that would read every message of every listed conversation to throw
 * all but one away.
 */
export async function loadConversationPreviews(
  prisma: PrismaClient,
  conversationIds: readonly string[],
): Promise<Map<string, string>> {
  if (conversationIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ conversationId: string; content: string }[]>(Prisma.sql`
    SELECT DISTINCT ON ("conversationId") "conversationId", "content"
    FROM "ai_conversation_message"
    WHERE "conversationId" IN (${Prisma.join([...conversationIds])})
      AND "role" = 'USER'
    ORDER BY "conversationId", "createdAt" ASC
  `);
  return new Map(rows.map((row) => [row.conversationId, collapse(row.content, PREVIEW_MAX_CHARS)]));
}

export function conversationToContract(
  conversation: ConversationRow,
  fallbackContextWindowTokens: number | null,
  preview: string,
): AiConversation {
  const contextWindowTokens =
    conversation.model?.contextWindowTokens ?? fallbackContextWindowTokens;
  const contextUsagePercent =
    contextWindowTokens === null || contextWindowTokens === 0
      ? 0
      : Math.min(
          100,
          Math.max(0, Math.round((conversation.estimatedTokens / contextWindowTokens) * 100)),
        );

  return {
    id: conversation.id,
    workspaceId: conversation.workspaceId,
    createdById: conversation.createdById,
    title: conversation.title,
    documentId: conversation.documentId,
    documentTitle: conversation.document?.title ?? null,
    preview,
    pageContextEnabled: conversation.pageContextEnabled,
    modelSlug: conversation.model?.slug ?? null,
    reasoningLevel: REASONING_LEVEL_TO_CONTRACT[conversation.reasoningLevel],
    visionCompanionSlug: conversation.visionCompanionSlug,
    estimatedTokens: conversation.estimatedTokens,
    contextUsagePercent,
    messageCount: conversation._count.messages,
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    createdAt: conversation.createdAt.toISOString(),
    archivedAt: conversation.archivedAt === null ? null : conversation.archivedAt.toISOString(),
  };
}

export function conversationMessageToContract(
  message: ConversationMessageRow,
): AiConversationMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: CONVERSATION_ROLE_TO_CONTRACT[message.role],
    content: message.content,
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    isSummary: message.isSummary,
    superseded: message.supersededAt !== null,
    runId: message.runId,
    createdAt: message.createdAt.toISOString(),
  };
}

/**
 * Loads a conversation and proves it belongs to the caller.
 *
 * Both halves matter and neither replaces the other: the workspace role is
 * re-read on every access so a removed member stops seeing anything, and the
 * creator check is what makes a conversation personal inside a shared
 * workspace. See the class comment on `ConversationsService`.
 */
export async function loadOwnedConversation(
  prisma: PrismaClient,
  access: WorkspaceAccessService,
  conversationId: string,
  userId: string,
): Promise<ConversationRow> {
  const conversation = await prisma.aiConversation.findUnique({
    where: { id: conversationId },
    select: CONVERSATION_SELECT,
  });
  if (conversation === null) throw AppError.notFound('AI conversation');

  const role = await access.findRole(conversation.workspaceId, userId);
  assertPolicy(canReadWorkspace(role));

  if (conversation.createdById !== userId) {
    throw AppError.forbidden('AI conversations are visible only to the user who created them');
  }
  return conversation;
}

/** Workspace ids the user is a member of, newest membership irrelevant: order comes later. */
export async function memberWorkspaceIds(prisma: PrismaClient, userId: string): Promise<string[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    select: { workspaceId: true },
  });
  return memberships.map((membership) => membership.workspaceId);
}

/**
 * The context window a conversation without an explicit model is measured
 * against. Null when no default model can be resolved at all, which the
 * contract reports as 0 % rather than as an error: a broken registry must not
 * make a transcript unreadable.
 */
export async function resolveFallbackContextWindow(
  modelResolver: AiModelResolverService,
): Promise<number | null> {
  try {
    return (await modelResolver.resolveDefault()).contextWindowTokens;
  } catch {
    return null;
  }
}
