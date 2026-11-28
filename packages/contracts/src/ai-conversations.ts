import { z } from 'zod';

import { aiRunSchema } from './ai';
import { aiReasoningLevelSchema } from './ai-models';
import { aiRunWrittenPagesSchema } from './ai-run-changes';
import { attachmentScreeningSchema } from './ai-trust';
import {
  ATTACHMENT_IMAGE_SOURCE_MIME_TYPES,
  isAttachmentImageSource,
  OFFICE_ATTACHMENT_MIME_TYPES,
} from './attachments';
import { idSchema, isoDateTimeSchema } from './primitives';

export const aiConversationRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type AiConversationRole = z.infer<typeof aiConversationRoleSchema>;

/**
 * Why a requested compaction ended without a summary (issue #287).
 *
 * - `nothing_to_compact`: fewer than two messages were still in the context
 *   when the worker looked.
 * - `provider_failed`: the summariser answered with an error or not at all.
 * - `key_unreadable`: the workspace's own key could not be read (ADR-091);
 *   nothing was sent.
 * - `abandoned`: the job ended without saying how, or the request outlived
 *   its lease without a worker taking it.
 */
export const aiConversationCompactionErrorSchema = z.enum([
  'nothing_to_compact',
  'provider_failed',
  'key_unreadable',
  'abandoned',
]);
export type AiConversationCompactionError = z.infer<typeof aiConversationCompactionErrorSchema>;

/**
 * How long a requested compaction holds its conversation (issue #287).
 *
 * While it holds, a new message is refused (`ai_conversation_compacting`), so
 * the summary never races a run over the same messages. The summariser's own
 * timeout is one minute; past twice that the request is treated as lost and
 * the conversation is free again, so a job that vanished can never lock a
 * chat for good.
 */
export const AI_CONVERSATION_COMPACTION_LEASE_MS = 120_000;

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
  /** Running estimate of the active messages alone; see `contextTokens` for what the meter shows. */
  estimatedTokens: z.number().int().nonnegative(),
  /**
   * The prompt size the context meter shows (issue #193): the input tokens the
   * provider reported for the newest turn when `contextTokensMeasured`, the
   * message estimate otherwise (before the first turn, after `/clear` or a
   * compaction), which leaves out the system prompt and the tool schemas.
   */
  contextTokens: z.number().int().nonnegative(),
  contextTokensMeasured: z.boolean(),
  /** The selected model's context window, or the default model's; null when neither is known. */
  contextWindowTokens: z.number().int().positive().nullable(),
  /**
   * `contextTokens` as a share of `contextWindowTokens`, to one decimal
   * (`contextUsagePercentOf`). Null when the window is unknown, which is not
   * the same as empty.
   */
  contextUsagePercent: z.number().min(0).max(100).nullable(),
  /**
   * When somebody asked for the history to be summarised and the worker has
   * not finished yet (issue #287); null otherwise, and null again once the
   * request outlived `AI_CONVERSATION_COMPACTION_LEASE_MS`.
   */
  compactRequestedAt: isoDateTimeSchema.nullable(),
  /** Why the last requested compaction left no summary; null after one that did. */
  compactionError: aiConversationCompactionErrorSchema.nullable(),
  messageCount: z.number().int().nonnegative(),
  lastMessageAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  archivedAt: isoDateTimeSchema.nullable(),
});
export type AiConversation = z.infer<typeof aiConversationSchema>;

/**
 * Share of a context window, to one decimal, clamped to 0..100.
 *
 * One function for the API and the browser, so a meter recomputed after a
 * model switch says the same as the server would. A prompt that holds
 * anything never reads 0: it reads at least 0.1, because 0 means empty.
 * Null when the window is unknown.
 */
export function contextUsagePercentOf(tokens: number, windowTokens: number | null): number | null {
  if (windowTokens === null || !(windowTokens > 0)) return null;
  if (tokens <= 0) return 0;
  const percent = Math.round((tokens / windowTokens) * 1000) / 10;
  return Math.min(100, Math.max(0.1, percent));
}

/**
 * Whether a chat file's text could be read (issue #223): `pending` while the
 * extraction runs, `ready` once it is there, `failed` when no engine could
 * read it, `none` for a picture or a document whose engine is switched off.
 */
export const AI_CHAT_ATTACHMENT_TEXT_STATES = ['none', 'pending', 'ready', 'failed'] as const;
export const aiChatAttachmentTextStateSchema = z.enum(AI_CHAT_ATTACHMENT_TEXT_STATES);
export type AiChatAttachmentTextState = z.infer<typeof aiChatAttachmentTextStateSchema>;

/** The text state of a stored attachment row, from its database enum. */
export function chatAttachmentTextStateOf(
  column: 'NOT_APPLICABLE' | 'PENDING' | 'READY' | 'FAILED',
): AiChatAttachmentTextState {
  if (column === 'PENDING') return 'pending';
  if (column === 'READY') return 'ready';
  if (column === 'FAILED') return 'failed';
  return 'none';
}

/**
 * A file somebody put on a chat message (issue #223).
 *
 * It belongs to the conversation, never to a page: only the conversation's
 * owner can read it, and deleting the conversation deletes it. A picture is
 * read through a vision model's description, stored here once, or as pixels
 * by a model that sees (ADR-097); a document through its extracted text
 * (ADR-050). Either is fenced as attachment content every time it reaches a
 * prompt (ADR-030).
 */
export const aiChatAttachmentSchema = z.object({
  id: idSchema,
  filename: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  /**
   * What a vision model saw, in the words the assistant was given. Null until
   * a run described the picture, and while nobody could: vision switched off,
   * no model to ask, or the call failed (the next run tries again). Always
   * null for a document.
   */
  description: z.string().nullable(),
  /** Whether a document's text was read; `none` for a picture. */
  textState: aiChatAttachmentTextStateSchema.default('none'),
  /**
   * What the screening for instructions to an AI found (ADR-096). Only
   * `clean` lets the assistant keep writing after reading the file; null
   * until somebody asked.
   */
  screening: attachmentScreeningSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
});
export type AiChatAttachment = z.infer<typeof aiChatAttachmentSchema>;

/**
 * Documents a chat message may carry (issue #223): what an extraction engine
 * reads (ADR-050), and plain text, Markdown, CSV and JSON, which are read as they
 * are when they arrive.
 */
export const CHAT_DOCUMENT_MIME_TYPES = [
  'application/pdf',
  ...OFFICE_ATTACHMENT_MIME_TYPES,
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
] as const;

/** Text files with no extraction engine: their bytes are their text. */
export const CHAT_PLAIN_TEXT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
] as const;

/** Whether a chat file of this type is a document rather than a picture. */
export function isChatDocumentMimeType(mimeType: string): boolean {
  return (CHAT_DOCUMENT_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Whether a chat file of this type is read as it is, without an extraction engine. */
export function isChatPlainTextMimeType(mimeType: string): boolean {
  return (CHAT_PLAIN_TEXT_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * Whether a file of this type can go on a chat message (issue #223).
 *
 * The raster images the image read accepts (ADR-088), and the documents
 * above. An SVG is a document that can carry script rather than a picture,
 * and stays out.
 */
export function isChatAttachmentMimeType(mimeType: string): boolean {
  return isAttachmentImageSource(mimeType) || isChatDocumentMimeType(mimeType);
}

const TEXT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
};

/**
 * The type a chat file declares, or, when a browser declared none, the one its
 * name says for a text format. Text has no magic bytes, so the upload checks
 * text against the declared type, and a Markdown file often arrives with an
 * empty one. Only ever a hint: the server still checks the bytes.
 */
export function chatAttachmentDeclaredType(
  filename: string,
  declared: string | undefined,
): string | undefined {
  if (declared !== undefined && declared.length > 0 && declared !== 'application/octet-stream') {
    return declared;
  }
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_TYPE_BY_EXTENSION[extension] ?? declared;
}

/** Every type the chat's file picker offers. */
export const CHAT_ATTACHMENT_MIME_TYPES = [
  ...ATTACHMENT_IMAGE_SOURCE_MIME_TYPES,
  ...CHAT_DOCUMENT_MIME_TYPES,
] as const;

/**
 * The most attachments one message may name, whatever the workspace allows.
 * The limit that applies is `ai.visionMaxImagesPerRun`, because no run
 * describes more pictures than that; this only bounds the request.
 */
export const AI_CHAT_ATTACHMENTS_MAX_PER_MESSAGE = 20;

/** The answer to `POST /api/ai/conversations/:id/attachments`. */
export const uploadChatAttachmentResponseSchema = z.object({
  attachment: aiChatAttachmentSchema,
});
export type UploadChatAttachmentResponse = z.infer<typeof uploadChatAttachmentResponseSchema>;

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
  /** The files sent with this message (issue #223); empty for every other. */
  attachments: z.array(aiChatAttachmentSchema).default([]),
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
  /**
   * The conversation's newest run, whatever became of it; `null` before the
   * first one. A failed run writes nothing into the transcript, so without
   * this a reader who comes back later finds the work of the run and no word
   * on why it stopped (2026-10-13).
   */
  lastRun: aiRunSchema.nullable(),
  /**
   * The pages each run of this conversation wrote, for the line under its
   * answer that names them and offers the way back (issue #248). Runs that
   * wrote nothing are absent.
   */
  runWrites: z.array(aiRunWrittenPagesSchema).default([]),
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
/**
 * How much of a handed-over selection reaches the transcript (issue #249).
 *
 * A selection is meant to be "this bit here", not a way to smuggle a whole
 * page past the page-context switch. The request may carry more (the schema
 * below allows 20 000), and the API cuts it here and says so in the text; the
 * chip row reads the same number to say so before anything is sent.
 */
export const MESSAGE_SELECTION_MAX_CHARS = 4_000;

export const messageSelectionSchema = z.object({
  blockIds: z.array(z.string().trim().min(1).max(64)).max(500).default([]),
  text: z.string().trim().min(1).max(20_000),
});
export type MessageSelection = z.infer<typeof messageSelectionSchema>;

export const postConversationMessageRequestSchema = z
  .object({
    /** May be empty only when the message carries attachments: a picture can be the question. */
    content: z.string().trim().max(20_000),
    documentId: idSchema.nullable().optional(),
    /** The open view, when `documentId` is a collection. Ignored for ordinary pages. */
    databaseViewId: idSchema.nullable().optional(),
    selection: messageSelectionSchema.nullable().optional(),
    /**
     * Files uploaded to this conversation beforehand and not sent yet
     * (issue #223), in the order they were added.
     */
    attachmentIds: z.array(idSchema).max(AI_CHAT_ATTACHMENTS_MAX_PER_MESSAGE).optional(),
    /** Overrides the conversation setting for this turn only. */
    reasoningLevel: aiReasoningLevelSchema.optional(),
    toolsEnabled: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.content.length > 0 || (value.attachmentIds?.length ?? 0) > 0) return;
    ctx.addIssue({
      code: 'custom',
      path: ['content'],
      message: 'A message needs text or at least one attachment',
    });
  });
export type PostConversationMessageRequest = z.infer<typeof postConversationMessageRequestSchema>;

// ---------------------------------------------------------------------------
// Pinned context sources (issue #75, ADR-043)
// ---------------------------------------------------------------------------

/** What a pinned source points at. */
export const aiConversationSourceKindSchema = z.enum(['PAGE', 'DATABASE_VIEW', 'SAVED_QUERY']);
export type AiConversationSourceKind = z.infer<typeof aiConversationSourceKindSchema>;

/**
 * Whether the source's text goes out with every turn or only its name does.
 *
 * `REFERENCE` is the default, and it is the one that costs nothing: the model
 * is told the source exists and how to fetch it, which is enough for a
 * tool-capable model. `EMBED` is the deliberate choice to pay for it on every
 * turn, and it is what the budget below is about.
 */
export const aiConversationSourceModeSchema = z.enum(['EMBED', 'REFERENCE']);
export type AiConversationSourceMode = z.infer<typeof aiConversationSourceModeSchema>;

export const aiConversationSourceSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  kind: aiConversationSourceKindSchema,
  mode: aiConversationSourceModeSchema,
  documentId: idSchema.nullable(),
  databaseViewId: idSchema.nullable(),
  savedQueryId: idSchema.nullable(),
  /** What the chip says. */
  title: z.string(),
  /** Where it sits: the parent page, the view's name, the query's description. */
  subtitle: z.string().nullable(),
  /** Characters this source contributes to the next turn. Zero in `REFERENCE` mode. */
  chars: z.number().int().nonnegative(),
  /** Characters it would contribute without the budget; larger than `chars` when it was cut. */
  fullChars: z.number().int().nonnegative(),
  /** Rough token cost of `chars`, so the chip can say what a turn pays. */
  tokens: z.number().int().nonnegative(),
  /** The budget cut this source short. Said in the prompt too, never only here. */
  truncated: z.boolean(),
  /** The target exists but has nothing to give: never materialized, no columns, no hits. */
  empty: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type AiConversationSource = z.infer<typeof aiConversationSourceSchema>;

export const aiConversationSourcesResponseSchema = z.object({
  sources: z.array(aiConversationSourceSchema),
  budget: z.object({
    /** `ai.pinnedContextMaxChars`, resolved for this workspace. */
    maxChars: z.number().int().nonnegative(),
    /** The share each embedded source may take, so a long page cannot eat the rest. */
    perSourceChars: z.number().int().nonnegative(),
    usedChars: z.number().int().nonnegative(),
    usedTokens: z.number().int().nonnegative(),
    /** `ai.maxPinnedSources`. Zero switches pinning off for the workspace. */
    maxSources: z.number().int().nonnegative(),
  }),
});
export type AiConversationSourcesResponse = z.infer<typeof aiConversationSourcesResponseSchema>;

/**
 * Pinning one source.
 *
 * `documentId` is required for `PAGE` and `DATABASE_VIEW`, `savedQueryId` for
 * `SAVED_QUERY`. Checked here rather than with a discriminated union so the
 * schema still turns into the flat JSON Schema the MCP catalogue serves.
 */
export const addAiConversationSourceRequestSchema = z
  .object({
    kind: aiConversationSourceKindSchema,
    documentId: idSchema.optional(),
    /** The view a `DATABASE_VIEW` source names. Omitted, the database's first view is used. */
    databaseViewId: idSchema.nullable().optional(),
    savedQueryId: idSchema.optional(),
    mode: aiConversationSourceModeSchema.default('REFERENCE'),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'SAVED_QUERY') {
      if (value.savedQueryId === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['savedQueryId'],
          message: 'savedQueryId is required for kind SAVED_QUERY',
        });
      }
      return;
    }
    if (value.documentId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentId'],
        message: `documentId is required for kind ${value.kind}`,
      });
    }
  });
export type AddAiConversationSourceRequest = z.infer<typeof addAiConversationSourceRequestSchema>;

export const updateAiConversationSourceRequestSchema = z.object({
  mode: aiConversationSourceModeSchema,
});
export type UpdateAiConversationSourceRequest = z.infer<
  typeof updateAiConversationSourceRequestSchema
>;

/**
 * Slash commands. Parsed server-side from the leading `/` of a user message so
 * every client (side panel, MCP, future clients) behaves identically.
 *
 * `description` is the German reference only: the panel reads
 * `ai.commands.<name>` and `/help` reads `commands.help.descriptions.<name>`
 * from the catalogue, in the reader's language.
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
  { name: 'compact', argument: null, description: 'Bisherigen Verlauf jetzt zusammenfassen' },
  {
    name: 'context',
    argument: 'on|off',
    description: 'Seitenkontext und angeheftete Quellen anzeigen oder umschalten',
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
  /**
   * Rendered as a system bubble in the chat, in the language of whoever typed
   * the command (`commands` namespace, ADR-062). The listing commands
   * (`/help`, `/tools`, `/rules`) answer in the chat's Markdown subset, one
   * list item per entry (issue #300); the others in plain text.
   */
  message: z.string(),
  /** Set when the command created or switched conversations. */
  conversationId: idSchema.nullable(),
  conversationChanged: z.boolean(),
});
export type ChatCommandResult = z.infer<typeof chatCommandResultSchema>;

/**
 * The answer to `POST /api/ai/conversations/:id/compact` (issue #287).
 *
 * A person's request is its own trigger: it does not ask the question the
 * automatic compaction asks (ADR-032, "would a smaller prompt change who can
 * serve this"), so `queued` is the ordinary answer even far below the
 * threshold. `wouldCompactAutomatically` says whether the automatic one
 * would have run anyway, which is what the short hint after the command
 * reads. The summary arrives later as an `isSummary` message and the
 * `ai.conversation.compacted` event; a failure as `compactionError` on the
 * conversation and `ai.conversation.compaction_failed`.
 */
export const aiConversationCompactResponseSchema = z.object({
  conversationId: idSchema,
  /**
   * `queued`: the worker summarises now. `already_queued`: an earlier request
   * still holds. `nothing_to_compact`: fewer than two messages are in the
   * context, so there is nothing a summary could replace.
   */
  status: z.enum(['queued', 'already_queued', 'nothing_to_compact']),
  /** Messages the summary will replace: every one still in the context. */
  messagesToSummarize: z.number().int().nonnegative(),
  contextUsagePercent: z.number().min(0).max(100).nullable(),
  /** `ai.compactionThresholdPercent` in force for this conversation's workspace. */
  thresholdPercent: z.number().int().min(0).max(100),
  wouldCompactAutomatically: z.boolean(),
});
export type AiConversationCompactResponse = z.infer<typeof aiConversationCompactResponseSchema>;

/** The longest title a suggestion may carry; a renamed title may be longer (160). */
export const AI_CONVERSATION_SUGGESTED_TITLE_MAX_CHARS = 60;

/**
 * Why no title was suggested (issue #233). `nothing_to_name`: the
 * conversation holds no message of the person or the assistant yet.
 * `provider_failed`: the model did not answer, or answered nothing usable.
 * `key_unreadable`: the workspace's own AI key cannot be read (ADR-091).
 * `timed_out`: the worker did not answer in time.
 */
export const aiConversationTitleSuggestionFailureSchema = z.enum([
  'nothing_to_name',
  'provider_failed',
  'key_unreadable',
  'timed_out',
]);
export type AiConversationTitleSuggestionFailure = z.infer<
  typeof aiConversationTitleSuggestionFailureSchema
>;

/**
 * The answer to `POST /api/ai/conversations/:id/title-suggestion` (issue
 * #233), and what the `conversation-title` job returns.
 *
 * A suggestion changes nothing: the title is only stored when a person saves
 * it through the ordinary rename (`PATCH /api/ai/conversations/:id`), after
 * reading and perhaps editing it. That is what keeps a title somebody chose
 * from being replaced behind their back.
 */
export const aiConversationTitleSuggestionSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('suggested'),
    title: z.string().min(1).max(AI_CONVERSATION_SUGGESTED_TITLE_MAX_CHARS),
  }),
  z.object({
    outcome: z.literal('failed'),
    reason: aiConversationTitleSuggestionFailureSchema,
  }),
]);
export type AiConversationTitleSuggestion = z.infer<typeof aiConversationTitleSuggestionSchema>;

export const aiConversationTitleSuggestionResponseSchema = z.object({
  conversationId: idSchema,
  /** The title the conversation has now, so a caller can compare. */
  currentTitle: z.string(),
  suggestion: aiConversationTitleSuggestionSchema,
});
export type AiConversationTitleSuggestionResponse = z.infer<
  typeof aiConversationTitleSuggestionResponseSchema
>;

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
  /** Files on its messages, rows and stored objects alike (issue #223). */
  attachmentsDeleted: z.number().int().nonnegative().default(0),
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
