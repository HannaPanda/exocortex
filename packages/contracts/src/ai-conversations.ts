import { z } from 'zod';

import { aiRunSchema } from './ai';
import { aiReasoningLevelSchema } from './ai-models';
import { idSchema, isoDateTimeSchema } from './primitives';

export const aiConversationRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type AiConversationRole = z.infer<typeof aiConversationRoleSchema>;

export const aiConversationSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  createdById: idSchema,
  title: z.string(),
  documentId: idSchema.nullable(),
  /** Whether the open page is disclosed to the model. `documentId` tracks it either way. */
  pageContextEnabled: z.boolean(),
  modelSlug: z.string().nullable(),
  reasoningLevel: aiReasoningLevelSchema,
  visionCompanionSlug: z.string().nullable(),
  estimatedTokens: z.number().int().nonnegative(),
  /** Share of the selected model's context window the active prompt occupies. */
  contextUsagePercent: z.number().int().min(0).max(100),
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  archivedAt: isoDateTimeSchema.nullable(),
});
export type AiConversation = z.infer<typeof aiConversationSchema>;

export const aiConversationMessageSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  role: aiConversationRoleSchema,
  content: z.string(),
  toolName: z.string().nullable(),
  toolCallId: z.string().nullable(),
  isSummary: z.boolean(),
  superseded: z.boolean(),
  runId: idSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type AiConversationMessage = z.infer<typeof aiConversationMessageSchema>;

export const aiConversationListResponseSchema = z.object({
  conversations: z.array(aiConversationSchema),
});
export type AiConversationListResponse = z.infer<typeof aiConversationListResponseSchema>;

export const aiConversationDetailResponseSchema = z.object({
  conversation: aiConversationSchema,
  messages: z.array(aiConversationMessageSchema),
});
export type AiConversationDetailResponse = z.infer<typeof aiConversationDetailResponseSchema>;

export const createAiConversationRequestSchema = z.object({
  workspaceId: idSchema,
  documentId: idSchema.nullable().default(null),
  title: z.string().trim().min(1).max(160).optional(),
  modelSlug: z.string().trim().min(1).max(120).optional(),
  reasoningLevel: aiReasoningLevelSchema.optional(),
  pageContextEnabled: z.boolean().optional(),
});
export type CreateAiConversationRequest = z.infer<typeof createAiConversationRequestSchema>;

export const updateAiConversationRequestSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  modelSlug: z.string().trim().min(1).max(120).optional(),
  reasoningLevel: aiReasoningLevelSchema.optional(),
  /** 'off' disables the companion for this conversation; null restores the admin default. */
  visionCompanionSlug: z.string().trim().min(1).max(120).nullable().optional(),
  pageContextEnabled: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type UpdateAiConversationRequest = z.infer<typeof updateAiConversationRequestSchema>;

/**
 * A passage the user picked in the editor and explicitly handed to the chat.
 *
 * Unlike the page context, this *is* document content leaving the system -- but
 * content the user selected, saw named in a chip, and sent on purpose, which is
 * no different from pasting it into the message. `blockIds` lets the assistant
 * address the passage later (`exo_page_read` returns the same identifiers)
 * instead of guessing where in the page it came from.
 */
export const messageSelectionSchema = z.object({
  blockIds: z.array(z.string().trim().min(1).max(64)).max(500).default([]),
  text: z.string().trim().min(1).max(20_000),
});
export type MessageSelection = z.infer<typeof messageSelectionSchema>;

export const postConversationMessageRequestSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  documentId: idSchema.nullable().optional(),
  /** The open view, when `documentId` is a collection. Ignored for ordinary pages. */
  databaseViewId: idSchema.nullable().optional(),
  selection: messageSelectionSchema.nullable().optional(),
  /** Overrides the conversation setting for this turn only. */
  reasoningLevel: aiReasoningLevelSchema.optional(),
  toolsEnabled: z.boolean().optional(),
});
export type PostConversationMessageRequest = z.infer<typeof postConversationMessageRequestSchema>;

/**
 * Slash commands. Parsed server-side from the leading `/` of a user message so
 * every client (side panel, MCP, future clients) behaves identically.
 */
export const CHAT_COMMANDS = [
  { name: 'clear', argument: null, description: 'Kontext leeren, Verlauf bleibt lesbar' },
  { name: 'new', argument: 'titel?', description: 'Neue Unterhaltung starten' },
  { name: 'model', argument: 'slug', description: 'Modell dieser Unterhaltung wechseln' },
  {
    name: 'think',
    argument: 'none|minimal|low|medium|high',
    description: 'Denkstufe wählen',
  },
  { name: 'vision', argument: 'slug|off', description: 'Vision-Begleitmodell überschreiben' },
  { name: 'compact', argument: null, description: 'Kontext jetzt zusammenfassen' },
  {
    name: 'context',
    argument: 'on|off',
    description: 'Seitenkontext anzeigen oder umschalten',
  },
  { name: 'rules', argument: null, description: 'Aktive Regelseiten anzeigen' },
  { name: 'tools', argument: null, description: 'Verfügbare Werkzeuge anzeigen' },
  { name: 'help', argument: null, description: 'Diese Liste anzeigen' },
] as const;
export const chatCommandNameSchema = z.enum(
  CHAT_COMMANDS.map((command) => command.name) as [string, ...string[]],
);
export type ChatCommandName = z.infer<typeof chatCommandNameSchema>;

export const chatCommandResultSchema = z.object({
  command: chatCommandNameSchema,
  /** German text rendered as a system bubble in the chat. */
  message: z.string(),
  /** Set when the command created or switched conversations. */
  conversationId: idSchema.nullable(),
  conversationChanged: z.boolean(),
});
export type ChatCommandResult = z.infer<typeof chatCommandResultSchema>;

/** Exactly one of `run` / `command` is set. */
export const postConversationMessageResponseSchema = z.object({
  run: aiRunSchema.nullable(),
  command: chatCommandResultSchema.nullable(),
  userMessage: aiConversationMessageSchema.nullable(),
});
export type PostConversationMessageResponse = z.infer<typeof postConversationMessageResponseSchema>;
