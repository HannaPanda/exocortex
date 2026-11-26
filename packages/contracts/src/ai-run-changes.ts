import { z } from 'zod';

import { idSchema } from './primitives';

/**
 * What one AI run changed on which page, and the way back (issue #248).
 *
 * Built from the agent write journal (ADR-022): every run of the built-in AI
 * writes under its own session, and every snapshotted write records the
 * top-level blocks it changed with a fingerprint of how it left them. Reading
 * this answers, per block, whether it still stands as the run left it; taking
 * the run back restores exactly those blocks and names every other one.
 */

/**
 * Where one block the run changed stands now.
 *
 * - `revertible`: still exactly as the run left it; an undo puts the earlier
 *   version back (or removes a block the run added).
 * - `changed_since`: somebody changed it after the run. An undo leaves it
 *   alone and names it, because overwriting it would lose their work.
 * - `reverted`: already as it was before the run, nothing left to do.
 */
export const aiRunChangedBlockStateSchema = z.enum(['revertible', 'changed_since', 'reverted']);
export type AiRunChangedBlockState = z.infer<typeof aiRunChangedBlockStateSchema>;

/** What the run did to the block: wrote it new, changed it or removed it. */
export const aiRunBlockChangeSchema = z.enum(['added', 'changed', 'removed']);
export type AiRunBlockChange = z.infer<typeof aiRunBlockChangeSchema>;

export const aiRunChangedBlockSchema = z.object({
  blockId: z.string(),
  /**
   * The change this block belongs to, numbered per page. A paragraph the run
   * replaced is usually two blocks (the old one removed, a new one written),
   * and they go back together or not at all; `state` is the group's.
   */
  group: z.number().int().nonnegative(),
  change: aiRunBlockChangeSchema,
  state: aiRunChangedBlockStateSchema,
  /** ProseMirror node type of the block as it stands now, or before the run when it is gone. */
  nodeType: z.string().nullable(),
  /** A short excerpt of its text as it stands now, or as it was when it is gone. */
  excerpt: z.string().nullable(),
});
export type AiRunChangedBlock = z.infer<typeof aiRunChangedBlockSchema>;

/**
 * Why a page the run wrote cannot be taken back block by block.
 *
 * - `no_snapshot`: only writes that leave no snapshot (a rename, a move).
 * - `not_recorded`: a write whose blocks were not recorded, from before the
 *   journal kept them or of a state that did not derive. An undo does not
 *   guess at blocks it cannot name; the page's history still has the snapshot.
 * - `unavailable`: the page is gone, or the caller may not read it.
 */
export const aiRunPageSkipReasonSchema = z.enum(['no_snapshot', 'not_recorded', 'unavailable']);
export type AiRunPageSkipReason = z.infer<typeof aiRunPageSkipReasonSchema>;

export const aiRunChangedPageSchema = z.object({
  documentId: idSchema,
  workspaceId: idSchema.nullable(),
  title: z.string().nullable(),
  /** The snapshot before the run's first write on this page: where "back" is. */
  snapshotId: idSchema.nullable(),
  /** Set when the page cannot be taken back block by block; `blocks` is then empty. */
  skipped: aiRunPageSkipReasonSchema.nullable(),
  blocks: z.array(aiRunChangedBlockSchema),
});
export type AiRunChangedPage = z.infer<typeof aiRunChangedPageSchema>;

export const aiRunChangesResponseSchema = z.object({
  runId: idSchema,
  pages: z.array(aiRunChangedPageSchema),
  /** Changes (groups, not blocks) an undo would restore now. */
  revertible: z.number().int().nonnegative(),
  /** Changes an undo would leave alone because somebody changed them since. */
  changedSince: z.number().int().nonnegative(),
  /** Whether the caller may take this run back: the person it ran for. */
  canRevert: z.boolean(),
});
export type AiRunChangesResponse = z.infer<typeof aiRunChangesResponseSchema>;

/**
 * The outcome of taking a run back. Partial by nature (ADR-022): one restore
 * per page, and the blocks changed since are named rather than overwritten.
 * `after` is the run's changes read again once the undo is done.
 */
export const aiRunRevertResponseSchema = z.object({
  runId: idSchema,
  restored: z.array(
    z.object({
      documentId: idSchema,
      title: z.string().nullable(),
      blockIds: z.array(z.string()),
    }),
  ),
  after: aiRunChangesResponseSchema,
});
export type AiRunRevertResponse = z.infer<typeof aiRunRevertResponseSchema>;

/**
 * The pages a run wrote, as the chat lists them under its answer. Cheap on
 * purpose: read from the journal alone, without deriving any state, so a
 * long conversation does not pay for an undo nobody asked about yet.
 */
export const aiRunWrittenPagesSchema = z.object({
  runId: idSchema,
  pages: z.array(
    z.object({
      documentId: idSchema,
      /** Where the page was when the run wrote it, for the link. */
      workspaceId: idSchema,
      title: z.string().nullable(),
    }),
  ),
});
export type AiRunWrittenPages = z.infer<typeof aiRunWrittenPagesSchema>;
