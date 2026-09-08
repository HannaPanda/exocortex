import { z } from 'zod';

import { memoryProjectSchema } from './memory';
import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * The layer above the session notes (issue #46).
 *
 * A note records what happened once. A fact records what is true until further
 * notice, and that is a different thing with different rules: it is confirmed
 * rather than repeated, it is superseded rather than edited, and it gets
 * quieter with age instead of being deleted on a birthday. These schemas are
 * that difference, written down.
 */

export const memoryFactStatusSchema = z.enum(['current', 'superseded', 'conflicted']);
export type MemoryFactStatus = z.infer<typeof memoryFactStatusSchema>;

export const memoryFactSchema = z.object({
  id: idSchema,
  /** The page carrying the wording. Readable, versioned, searchable as usual. */
  documentId: idSchema,
  workspaceId: idSchema,
  projectKey: z.string(),
  /** The statement itself, one line: the page title. */
  statement: z.string(),
  /** The elaboration under it, if the distiller wrote one. */
  detail: z.string(),
  status: memoryFactStatusSchema,
  /** Ranking weight between 0 and 1, not a probability. */
  confidence: z.number().min(0).max(1),
  confirmations: z.number().int().nonnegative(),
  firstSeenAt: isoDateTimeSchema,
  lastConfirmedAt: isoDateTimeSchema,
  /** The fact that replaced this one, when `status` is `superseded`. */
  supersededById: idSchema.nullable(),
  /** Page in the curated brain this was promoted into, and when. */
  promotedDocumentId: idSchema.nullable(),
  promotedAt: isoDateTimeSchema.nullable(),
  /** The notes this was distilled from, newest first. Capped. */
  sourceNoteIds: z.array(idSchema),
});
export type MemoryFact = z.infer<typeof memoryFactSchema>;

export const memoryFactListQuerySchema = z.object({
  project: memoryProjectSchema.optional(),
  /**
   * Which states to include. Defaults to the current ones alone: a caller that
   * asks "what do we know" wants what holds now, and a superseded fact answering
   * alongside its successor is exactly the confusion facts exist to end.
   */
  status: z
    .union([memoryFactStatusSchema, z.array(memoryFactStatusSchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .default(['current']),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type MemoryFactListQuery = z.infer<typeof memoryFactListQuerySchema>;

export const memoryFactListResponseSchema = z.object({
  project: z.string().nullable(),
  facts: z.array(memoryFactSchema),
  /** Facts in the project that the filter left out. Tells a caller there is more. */
  omitted: z.number().int().nonnegative(),
});
export type MemoryFactListResponse = z.infer<typeof memoryFactListResponseSchema>;

/**
 * What a consolidation run decided about one note.
 *
 * Five verdicts, and the fifth is the important one: `discard` is how a run
 * says "this note holds nothing worth keeping" without the note being read
 * again tomorrow. Without it the cheapest possible answer would also be the
 * most expensive one.
 */
export const memoryFactVerdictKindSchema = z.enum([
  'new',
  'confirms',
  'supersedes',
  'conflicts',
  'discard',
]);
export type MemoryFactVerdictKind = z.infer<typeof memoryFactVerdictKindSchema>;

export const memoryFactVerdictSchema = z
  .object({
    kind: memoryFactVerdictKindSchema,
    /** The note this verdict came from. Must be one of the request's `noteIds`. */
    noteId: idSchema,
    /** The fact being confirmed, replaced or contradicted. Null for `new` and `discard`. */
    factId: idSchema.nullable().default(null),
    /** The statement, one line. Required for `new` and `supersedes`. */
    statement: z.string().trim().min(3).max(200).nullable().default(null),
    /** Elaboration in Markdown. Optional even where a statement is required. */
    detail: z.string().trim().max(4_000).default(''),
  })
  .superRefine((verdict, ctx) => {
    const needsFact = verdict.kind !== 'new' && verdict.kind !== 'discard';
    if (needsFact && verdict.factId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['factId'],
        message: `A ${verdict.kind} verdict must name the fact it acts on`,
      });
    }
    const needsStatement = verdict.kind === 'new' || verdict.kind === 'supersedes';
    if (needsStatement && verdict.statement === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['statement'],
        message: `A ${verdict.kind} verdict must carry a statement`,
      });
    }
  });
export type MemoryFactVerdict = z.infer<typeof memoryFactVerdictSchema>;

/**
 * Applies one consolidation run.
 *
 * `noteIds` is the whole batch that was looked at, verdicts or not: every note
 * in it is marked as read, which is what stops tonight's batch from being
 * tomorrow's batch. A verdict about a note outside the batch is refused rather
 * than silently applied, because that is the shape a hallucinated id takes.
 */
export const memoryConsolidateRequestSchema = z.object({
  project: memoryProjectSchema,
  noteIds: z.array(idSchema).min(1).max(200),
  verdicts: z.array(memoryFactVerdictSchema).max(200).default([]),
});
export type MemoryConsolidateRequest = z.infer<typeof memoryConsolidateRequestSchema>;

export const memoryConsolidateResponseSchema = z.object({
  project: z.string(),
  notesRead: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
  conflicted: z.number().int().nonnegative(),
  discarded: z.number().int().nonnegative(),
  /** Verdicts that named something that does not exist, for the worker to log. */
  rejected: z.number().int().nonnegative(),
});
export type MemoryConsolidateResponse = z.infer<typeof memoryConsolidateResponseSchema>;

/**
 * Copies a fact into the curated brain.
 *
 * Never automatic. The memory workspace is the agents' and may be swept; the
 * brain is a person's and is not (ADR-019). Crossing that line is a decision,
 * so it is an explicit call with an explicit destination.
 */
export const memoryFactPromoteRequestSchema = z.object({
  /** Destination workspace. Must be one the caller may write to. */
  workspaceId: idSchema,
  /** Page to hang it under. Null puts it at the workspace root. */
  parentId: idSchema.nullable().default(null),
});
export type MemoryFactPromoteRequest = z.infer<typeof memoryFactPromoteRequestSchema>;

export const memoryFactPromoteResponseSchema = z.object({
  factId: idSchema,
  documentId: idSchema,
  workspaceId: idSchema,
  title: z.string(),
  url: z.string().nullable(),
  /** True when the fact had already been promoted and this returned that page. */
  alreadyPromoted: z.boolean(),
});
export type MemoryFactPromoteResponse = z.infer<typeof memoryFactPromoteResponseSchema>;
