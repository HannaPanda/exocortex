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

/**
 * A block somebody wrote since the run, standing where one of the run's
 * blocks stood (issue #248). A rewrite in another editor, a split paragraph
 * or another agent's narrow write gives the text a new identifier, so the
 * block the run wrote is gone and this is what an undo holds back.
 */
export const aiRunStandingBlockSchema = z.object({
  blockId: z.string(),
  nodeType: z.string().nullable(),
  excerpt: z.string().nullable(),
});
export type AiRunStandingBlock = z.infer<typeof aiRunStandingBlockSchema>;

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
  /**
   * A short excerpt of its text as it stands now; for a removed block, as it
   * was. `null` for a block the run wrote that is gone since: its text is the
   * run's, and what stands in its place is in `standing`.
   */
  excerpt: z.string().nullable(),
  /**
   * For a change held back (`changed_since`): the blocks somebody wrote since
   * that stand right where this one stood, under identifiers of their own.
   * Empty otherwise. This is the text the undo leaves alone.
   */
  standing: z.array(aiRunStandingBlockSchema),
});
export type AiRunChangedBlock = z.infer<typeof aiRunChangedBlockSchema>;

/**
 * What a run did to a page itself rather than to its blocks (issue #248).
 *
 * - `created`: the run made the page. An undo moves it to the trash, never
 *   deletes it for good, and only while nobody has written in it, renamed it
 *   or put a page of their own under it.
 * - `moved`: the run moved the page. An undo puts it back under its old
 *   parent, near its old place, while it still stands where the run left it.
 * - `renamed`: the run renamed the page. An undo gives the old title back
 *   while the page still carries the run's.
 */
export const aiRunStructureKindSchema = z.enum(['created', 'moved', 'renamed']);
export type AiRunStructureKind = z.infer<typeof aiRunStructureKindSchema>;

/**
 * Why a structural change is held back (`state: changed_since`).
 *
 * - `edited`: somebody wrote in the page the run created, or changed one of
 *   its properties.
 * - `renamed`: the title is no longer the one the run left.
 * - `moved`: the page stands somewhere else than where the run left it.
 * - `trashed`: the page is in the trash now.
 * - `children`: the page the run created holds a page somebody else put
 *   there, or one of its own that is held back; the trash would take it too.
 * - `parent_gone`: the page the run moved it away from is gone or in the trash.
 * - `other_workspace`: a move between workspaces took the whole subtree along,
 *   and is named rather than undone.
 * - `not_a_page`: the run created a database or a project, whose contents an
 *   undo cannot vouch for.
 * - `not_recorded`: the run is older than this record.
 */
export const aiRunStructureHeldReasonSchema = z.enum([
  'edited',
  'renamed',
  'moved',
  'trashed',
  'children',
  'parent_gone',
  'other_workspace',
  'not_a_page',
  'not_recorded',
]);
export type AiRunStructureHeldReason = z.infer<typeof aiRunStructureHeldReasonSchema>;

export const aiRunStructureChangeSchema = z.object({
  kind: aiRunStructureKindSchema,
  /** Same three answers as a block; `changed_since` also covers a change an undo leaves alone. */
  state: aiRunChangedBlockStateSchema,
  /** Set when `state` is `changed_since`. */
  reason: aiRunStructureHeldReasonSchema.nullable(),
  /** `renamed`: the title before the run and the one it gave. */
  fromTitle: z.string().nullable(),
  toTitle: z.string().nullable(),
  /**
   * `moved`: the parent before and after (`null` is the top level of the
   * workspace), with their titles where the caller may read them.
   */
  fromParentId: idSchema.nullable(),
  fromParentTitle: z.string().nullable(),
  toParentId: idSchema.nullable(),
  toParentTitle: z.string().nullable(),
});
export type AiRunStructureChange = z.infer<typeof aiRunStructureChangeSchema>;

/**
 * Why a page the run wrote cannot be taken back block by block.
 *
 * - `no_snapshot`: no write that leaves a snapshot, and nothing in
 *   `structure` either.
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
  /** Empty for a page the run created: taking that back is the `created` change. */
  blocks: z.array(aiRunChangedBlockSchema),
  /** The page's rename, move and creation by the run, at most one of each. */
  structure: z.array(aiRunStructureChangeSchema),
});
export type AiRunChangedPage = z.infer<typeof aiRunChangedPageSchema>;

export const aiRunChangesResponseSchema = z.object({
  runId: idSchema,
  pages: z.array(aiRunChangedPageSchema),
  /** Changes (groups of blocks, and structural changes) an undo would take back now. */
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
      /** The structural changes taken back on this page. */
      structure: z.array(aiRunStructureKindSchema),
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
