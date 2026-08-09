import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * Comments on a page (issue #18).
 *
 * A comment is *about* a page, never part of it, so none of this travels in the
 * Yjs state or in a Markdown export. A thread is one root comment plus its
 * replies, one level deep.
 */

/** Upper bound on a comment body. Long enough for a paragraph, not for an essay. */
export const COMMENT_BODY_MAX_CHARS = 10_000;

/**
 * Length of the quoted block text stored with an anchored thread.
 *
 * Only a reminder of what was commented on, which is why it is a snapshot taken
 * at creation time and never refreshed: it has to keep saying what the thread
 * was about even after the block has been rewritten or deleted.
 */
export const COMMENT_ANCHOR_TEXT_MAX_CHARS = 240;

export const commentBodySchema = z.string().trim().min(1).max(COMMENT_BODY_MAX_CHARS);

/**
 * A block identifier from `@exocortex/editor`. Same shape as `isValidBlockId`
 * there; repeated rather than imported, because contracts is a leaf package.
 */
export const commentBlockIdSchema = z.string().regex(/^[a-z0-9]{8,32}$/);

/** Who wrote or resolved something. Never more of the user record than this. */
export const commentAuthorSchema = z.object({
  id: idSchema,
  name: z.string(),
});
export type CommentAuthor = z.infer<typeof commentAuthorSchema>;

export const commentSchema = z.object({
  id: idSchema,
  documentId: idSchema,
  /** `null` for the root of a thread. */
  parentId: idSchema.nullable(),
  /** `null` means the comment is about the page as a whole. */
  blockId: z.string().nullable(),
  /** The anchored block's text when the thread was opened. `null` when unanchored. */
  anchorText: z.string().nullable(),
  /**
   * True when the anchored block no longer exists in the page. The thread stays
   * and says so; it is never deleted along with the block.
   */
  orphaned: z.boolean(),
  body: z.string(),
  createdBy: commentAuthorSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  /** Set once the author has rewritten the body. */
  editedAt: isoDateTimeSchema.nullable(),
  resolvedAt: isoDateTimeSchema.nullable(),
  resolvedBy: commentAuthorSchema.nullable(),
});
export type Comment = z.infer<typeof commentSchema>;

/** A root comment together with its replies, oldest first. */
export const commentThreadSchema = z.object({
  root: commentSchema,
  replies: z.array(commentSchema),
});
export type CommentThread = z.infer<typeof commentThreadSchema>;

export const commentListResponseSchema = z.object({
  /** Open threads first, then resolved ones; each group oldest first. */
  threads: z.array(commentThreadSchema),
  openCount: z.number().int().nonnegative(),
  resolvedCount: z.number().int().nonnegative(),
});
export type CommentListResponse = z.infer<typeof commentListResponseSchema>;

export const listCommentsQuerySchema = z.object({
  /** `false` hides resolved threads entirely; the counts still report them. */
  includeResolved: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .transform((value) => value === true || value === 'true')
    .default(true),
});
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;

export const createCommentRequestSchema = z.object({
  body: commentBodySchema,
  /**
   * Anchors the new thread to a block. Ignored when `parentId` is given: a
   * reply inherits the thread's anchor, it does not carry one of its own.
   */
  blockId: commentBlockIdSchema.nullable().optional(),
  /** Quoted text of the anchored block, for the orphaned case. */
  anchorText: z.string().trim().max(COMMENT_ANCHOR_TEXT_MAX_CHARS).nullable().optional(),
  /** The root comment this is a reply to. `null`/absent opens a new thread. */
  parentId: idSchema.nullable().optional(),
});
export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;

export const updateCommentRequestSchema = z.object({
  body: commentBodySchema,
});
export type UpdateCommentRequest = z.infer<typeof updateCommentRequestSchema>;

/**
 * Resolving and reopening are one endpoint with a flag rather than two routes:
 * the UI toggles, and a toggle that maps to two verbs invites the state to be
 * read twice and set twice.
 */
export const resolveCommentRequestSchema = z.object({
  resolved: z.boolean(),
});
export type ResolveCommentRequest = z.infer<typeof resolveCommentRequestSchema>;

export const deleteCommentResponseSchema = z.object({
  deleted: z.literal(true),
  /** Replies removed along with a thread root. Zero for a reply. */
  removedReplies: z.number().int().nonnegative(),
});
export type DeleteCommentResponse = z.infer<typeof deleteCommentResponseSchema>;

/** Single-comment response shape, shared by create, update and resolve. */
export const commentResponseSchema = z.object({
  comment: commentSchema,
});
export type CommentResponse = z.infer<typeof commentResponseSchema>;
