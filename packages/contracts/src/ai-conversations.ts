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
  /** Title of the page the conversation stands on. Carried along so a list does not have to ask per row. */
  documentTitle: z.string().nullable(),
  /**
   * The conversation's first user line, collapsed and cut.
   *
   * A title derived from that same line says what was asked; the preview says
   * how it was asked, which is what a person recognizes weeks later. Empty for
   * a conversation nobody has written in yet.
   */
  preview: z.string(),
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

/** Which half of the archive a listing asks for. */
export const aiConversationArchivedFilterSchema = z.enum(['open', 'archived', 'all']);
export type AiConversationArchivedFilter = z.infer<typeof aiConversationArchivedFilterSchema>;

export const AI_CONVERSATION_PAGE_SIZE = 30;
export const AI_CONVERSATION_MAX_PAGE_SIZE = 100;

export const aiConversationListResponseSchema = z.object({
  conversations: z.array(aiConversationSchema),
  /** Opaque; hand it back as `cursor` for the next page. Null when the list is exhausted. */
  nextCursor: z.string().nullable(),
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
    argument: 'none|minimal|low|medium|high|xhigh|max',
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

// ---------------------------------------------------------------------------
// Finding a conversation again (issue #69)
// ---------------------------------------------------------------------------

export const AI_CONVERSATION_SEARCH_LIMIT = 30;

/**
 * One conversation that matched, with the passage that matched in it.
 *
 * The unit of a result is the conversation and not the message: what a person
 * is looking for is "the chat about nginx", and a list of forty lines out of
 * the same afternoon would bury it. `matchCount` says how much else is in
 * there, and the snippet is the best-ranked line.
 */
export const aiConversationSearchHitSchema = z.object({
  conversation: aiConversationSchema,
  /** `ts_headline` output: the matching passage with `<mark>` around the terms. */
  snippet: z.string(),
  messageId: idSchema,
  messageRole: aiConversationRoleSchema,
  messageCreatedAt: isoDateTimeSchema,
  /** True when the matching line has dropped out of the context. It stays findable. */
  messageSuperseded: z.boolean(),
  matchCount: z.number().int().positive(),
});
export type AiConversationSearchHit = z.infer<typeof aiConversationSearchHitSchema>;

export const aiConversationSearchResponseSchema = z.object({
  query: z.string(),
  hits: z.array(aiConversationSearchHitSchema),
});
export type AiConversationSearchResponse = z.infer<typeof aiConversationSearchResponseSchema>;

/**
 * What an irreversible delete leaves behind.
 *
 * `runsPruned` rather than "runs deleted" on purpose: the transcript goes, the
 * run rows stay as the bare metrics they also are. See
 * `ConversationsService.deletePermanently`.
 */
export const aiConversationDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  messagesDeleted: z.number().int().nonnegative(),
  runsPruned: z.number().int().nonnegative(),
});
export type AiConversationDeleteResponse = z.infer<typeof aiConversationDeleteResponseSchema>;

export const conversationToPageRequestSchema = z.object({
  /** Where the page goes. Null puts it at the top level of the conversation's workspace. */
  parentId: idSchema.nullable().default(null),
  title: z.string().trim().min(1).max(160).optional(),
});
export type ConversationToPageRequest = z.infer<typeof conversationToPageRequestSchema>;

export const conversationToPageResponseSchema = z.object({
  conversationId: idSchema,
  documentId: idSchema,
  workspaceId: idSchema,
  title: z.string(),
  url: z.string(),
});
export type ConversationToPageResponse = z.infer<typeof conversationToPageResponseSchema>;
