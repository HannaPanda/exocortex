import { z } from 'zod';

import { documentPathEntrySchema } from './documents';
import { entityTypeSchema } from './entities';
import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * The agent memory surface (issue #34).
 *
 * Three verbs, deliberately few: `recall` reads, `remember` writes one
 * distilled note, `capture` hands over a raw session for the worker to distill.
 * They are a layer above search and documents rather than beside them, because
 * a memory is not a page a human filed: it carries a project, a client and a
 * timestamp, and it is written into one configured workspace instead of
 * wherever the caller points.
 */

/**
 * Which client produced a memory.
 *
 * Recorded as a property of the note, not of the workspace: all agents share
 * one memory area on purpose, so that ChatGPT can read what Claude Code
 * learned yesterday. `other` keeps a client that is not in this list from
 * being refused at the boundary.
 */
export const memoryClientSchema = z.enum([
  'claude-code',
  'hermes',
  'chatgpt',
  'exocortex',
  'other',
]);
export type MemoryClient = z.infer<typeof memoryClientSchema>;

/**
 * The project a memory belongs to.
 *
 * Free text, because it is whatever the caller works on: usually a working
 * directory (`/var/www/exocortex`) or a repository name. The API derives a
 * readable label and a stable key from it, so `/var/www/exocortex` and
 * `/var/www/exocortex/` end up on the same page.
 */
export const memoryProjectSchema = z.string().trim().min(1).max(300);

export const memoryRecallRequestSchema = z.object({
  /**
   * What to look for. Optional on purpose: a session that has just started has
   * no question yet, only a working directory, and then the answer is "the
   * most recent notes for this project".
   */
  q: z.string().trim().min(1).max(200).optional(),
  project: memoryProjectSchema.optional(),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  /**
   * Ceiling for the whole answer. The injection hook pastes this into a
   * session's context, so an unbounded recall would eat the context it is
   * supposed to improve.
   */
  maxChars: z.coerce.number().int().min(500).max(50_000).default(6_000),
  /**
   * Whether to look beyond the memory workspace, into every other workspace
   * the caller can read. On by default: the infrastructure notes an agent
   * needs live in the curated brain, and a memory without sight of them is
   * half blind.
   */
  includeKnowledge: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(true),
});
export type MemoryRecallRequest = z.infer<typeof memoryRecallRequestSchema>;

/** Where a hit came from. `memory` is the agents' own area, `knowledge` is everything else. */
export const memorySourceSchema = z.enum(['memory', 'knowledge']);
export type MemorySource = z.infer<typeof memorySourceSchema>;

export const memoryHitSchema = z.object({
  documentId: idSchema,
  workspaceId: idSchema,
  workspaceName: z.string(),
  title: z.string(),
  path: z.array(documentPathEntrySchema),
  /** A few distilled lines, never a whole page. `fetch` loads the rest. */
  snippet: z.string(),
  source: memorySourceSchema,
  score: z.number(),
  updatedAt: isoDateTimeSchema,
});
export type MemoryHit = z.infer<typeof memoryHitSchema>;

/**
 * A distilled fact as a recall shows it (issue #46).
 *
 * Deliberately thinner than the full fact: a recall answers "what holds here",
 * and the bookkeeping that decides which facts hold is nobody's business at
 * that moment. `GET /api/memory/facts` has the rest.
 */
export const memoryRecallFactSchema = z.object({
  id: idSchema,
  documentId: idSchema,
  statement: z.string(),
  confirmations: z.number().int().nonnegative(),
  lastConfirmedAt: isoDateTimeSchema,
});
export type MemoryRecallFact = z.infer<typeof memoryRecallFactSchema>;

/**
 * An entity the recall's question named (issue #47).
 *
 * The reason the entity layer exists: a session that asks about a host should
 * get what is known about that host, not five pages that happen to contain its
 * name. Carries the rendered block rather than the full profile, because a
 * recall is a prompt and `GET /api/entities/:id` is the place to read the rest.
 */
export const memoryRecallEntitySchema = z.object({
  id: idSchema,
  title: z.string(),
  type: entityTypeSchema,
  /** The profile as German text, already inside the recall's budget. */
  text: z.string(),
});
export type MemoryRecallEntity = z.infer<typeof memoryRecallEntitySchema>;

/**
 * The mailbox between agents (issue #51, ADR-047).
 *
 * Here rather than in a file of its own because it is the same surface: sender
 * and recipient are addressed through the memory area they share, the messages
 * ride along in the recall a session starts with, and `memoryClientSchema`
 * already says who is talking.
 *
 * A message is not a page (ADR-047). It is a delivery: addressed, read once,
 * and gone when it expires.
 */

/** Who a message is from or to, in the two fields anybody needs to read one. */
export const agentMessagePartySchema = z.object({
  userId: idSchema,
  /** The account's display name, which is how a sender addresses it. */
  name: z.string(),
});
export type AgentMessageParty = z.infer<typeof agentMessagePartySchema>;

export const agentMessageSchema = z.object({
  id: idSchema,
  from: agentMessagePartySchema,
  to: agentMessagePartySchema,
  subject: z.string(),
  body: z.string(),
  client: memoryClientSchema,
  /** The project the message is about, or null when it is about no directory. */
  project: z.string().nullable(),
  /** The page the message points at, if any. */
  documentId: idSchema.nullable(),
  read: z.boolean(),
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const agentMessageSendRequestSchema = z.object({
  /**
   * The recipient, by display name or by email address, matched among the
   * members of the sender's memory area. Not an id: the caller is a model that
   * has a name in front of it and no directory to look an id up in, and the
   * listing endpoint answers with the names it may use.
   */
  to: z.string().trim().min(1).max(320),
  subject: z.string().trim().min(1).max(200),
  /**
   * The message. Short on purpose: this is a note left for another agent, and
   * anything that needs more room is a page with a link to it.
   */
  body: z.string().trim().min(1).max(4_000),
  client: memoryClientSchema.default('other'),
  project: memoryProjectSchema.optional(),
  documentId: idSchema.optional(),
  /**
   * How long it waits. A mailbox without expiry becomes a tip, and a message
   * nobody collected in two weeks has usually stopped being true.
   */
  expiresInDays: z.number().int().min(1).max(90).optional(),
});
export type AgentMessageSendRequest = z.infer<typeof agentMessageSendRequestSchema>;

export const agentMessageSendResponseSchema = z.object({
  message: agentMessageSchema,
  /** How many of the recipient's messages are now waiting, this one included. */
  waiting: z.number().int().nonnegative(),
});
export type AgentMessageSendResponse = z.infer<typeof agentMessageSendResponseSchema>;

export const agentMessageBoxSchema = z.enum(['inbox', 'sent']);
export type AgentMessageBox = z.infer<typeof agentMessageBoxSchema>;

export const agentMessageListQuerySchema = z.object({
  box: agentMessageBoxSchema.default('inbox'),
  /** `unread` is the default: the question a session asks at its start. */
  status: z.enum(['unread', 'all']).default('unread'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type AgentMessageListQuery = z.infer<typeof agentMessageListQuerySchema>;

export const agentMessageListResponseSchema = z.object({
  messages: z.array(agentMessageSchema),
  /** Unread messages waiting, whatever `limit` and `status` asked for. */
  unread: z.number().int().nonnegative(),
  /**
   * Who else shares this memory area, and may therefore be written to. Part of
   * the listing rather than an endpoint of its own: an agent that cannot see
   * the names guesses them, and a guessed recipient is a refused send.
   */
  recipients: z.array(agentMessagePartySchema),
  /**
   * The messages as one block of German text, fenced as somebody else's words.
   * Rendered here for the same reason the recall's text is: the session-start
   * hook pastes it, and the fence is a safety property rather than formatting.
   */
  text: z.string(),
});
export type AgentMessageListResponse = z.infer<typeof agentMessageListResponseSchema>;

export const agentMessageReadRequestSchema = z.object({
  /** The messages to acknowledge. Only the recipient's own are ever marked. */
  ids: z.array(idSchema).min(1).max(50),
});
export type AgentMessageReadRequest = z.infer<typeof agentMessageReadRequestSchema>;

export const agentMessageReadResponseSchema = z.object({
  /** How many were newly marked. Zero is a success: marking twice is a no-op. */
  marked: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
});
export type AgentMessageReadResponse = z.infer<typeof agentMessageReadResponseSchema>;

export const memoryRecallResponseSchema = z.object({
  query: z.string().nullable(),
  project: z.string().nullable(),
  /**
   * What the memory holds to be true for this project, before the hits and
   * regardless of the query. Empty unless a project was named and something has
   * been consolidated for it.
   */
  facts: z.array(memoryRecallFactSchema).default([]),
  /**
   * Entities the question named, ahead of everything else. Empty when the
   * layer is off, when nothing matched, or when the recall carried no query.
   */
  entities: z.array(memoryRecallEntitySchema).default([]),
  /**
   * Unread mail from other agents, ahead of everything else and capped by
   * `memory.recallMessageLimit` (issue #51). Reading a recall does not mark
   * them read: a session that dies in its first second must not have lost its
   * post. `POST /api/memory/messages/read` is the acknowledgement.
   */
  messages: z.array(agentMessageSchema).default([]),
  hits: z.array(memoryHitSchema),
  /**
   * The facts and the hits as one block of German text, already inside
   * `maxChars`. The injection hook pastes exactly this and needs no formatting
   * logic of its own; a model client can ignore it and read the fields instead.
   */
  text: z.string(),
  /** True when hits were dropped to stay inside `maxChars`. */
  truncated: z.boolean(),
  tookMs: z.number().int().nonnegative(),
});
export type MemoryRecallResponse = z.infer<typeof memoryRecallResponseSchema>;

export const memoryRememberRequestSchema = z.object({
  project: memoryProjectSchema,
  /** Headline of the note. Omitted lets the API date it. */
  title: z.string().trim().min(1).max(200).optional(),
  /** The note itself, as Markdown. Already distilled: nobody stores a transcript here. */
  text: z.string().trim().min(1).max(20_000),
  client: memoryClientSchema.default('other'),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  /**
   * Appends to today's note for this project instead of starting a new one.
   * What a chat client wants: a conversation produces several small memories,
   * and one page per thought would bury the project page in stubs.
   */
  appendToday: z.boolean().default(false),
  /**
   * When the remembered thing happened. Defaults to now, which is right for
   * every live caller. It matters for a capture that arrives late: a session
   * distilled from a stored transcript weeks afterwards would otherwise be
   * dated the day it was replayed, and a memory that lies about when something
   * happened is worse than no memory.
   */
  occurredAt: isoDateTimeSchema.optional(),
});
export type MemoryRememberRequest = z.infer<typeof memoryRememberRequestSchema>;

export const memoryRememberResponseSchema = z.object({
  documentId: idSchema,
  workspaceId: idSchema,
  title: z.string(),
  /** True when the note was appended to a page that already existed. */
  appended: z.boolean(),
  url: z.string().nullable(),
});
export type MemoryRememberResponse = z.infer<typeof memoryRememberResponseSchema>;

/**
 * Hands a finished working session over for distillation.
 *
 * The raw text never becomes the memory. It goes into a job, a model turns it
 * into a handful of German bullet points, and only that is written. The
 * endpoint answers as soon as the job is queued, because the caller is a hook
 * inside somebody's editor and must not be kept waiting.
 */
export const memoryCaptureRequestSchema = z.object({
  project: memoryProjectSchema,
  client: memoryClientSchema.default('other'),
  /** The client's own session identifier, so a repeated hook call is recognisable. */
  sessionId: z.string().trim().min(1).max(200).optional(),
  /** The conversation, already trimmed by the caller. */
  transcript: z.string().trim().min(1).max(400_000),
  /** What the caller believes the session was about. Used as a hint, not as the title. */
  hint: z.string().trim().max(500).optional(),
  /**
   * When the session ended, which is when a live hook fires. Defaults to now.
   * A client replaying an old transcript sends the real one, so the note is
   * dated by the session rather than by the replay.
   */
  endedAt: isoDateTimeSchema.optional(),
});
export type MemoryCaptureRequest = z.infer<typeof memoryCaptureRequestSchema>;

export const memoryCaptureResponseSchema = z.object({
  accepted: z.boolean(),
  /** Null when the deployment has no memory workspace configured yet. */
  jobId: z.string().nullable(),
  /** Why nothing was queued, in English, for a hook to log. Null on success. */
  reason: z.string().nullable(),
});
export type MemoryCaptureResponse = z.infer<typeof memoryCaptureResponseSchema>;
