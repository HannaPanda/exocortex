import { z } from 'zod';

import { documentPathEntrySchema } from './documents';
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

export const memoryRecallResponseSchema = z.object({
  query: z.string().nullable(),
  project: z.string().nullable(),
  hits: z.array(memoryHitSchema),
  /**
   * The same hits as one block of German text, already inside `maxChars`.
   * The injection hook pastes exactly this and needs no formatting logic of
   * its own; a model client can ignore it and read `hits` instead.
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
  startedAt: isoDateTimeSchema.optional(),
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
