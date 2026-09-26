import { z } from 'zod';

import {
  documentBlockWriteRequestSchema,
  documentDiffBlockSchema,
  documentPatchRequestSchema,
  documentSectionWriteRequestSchema,
} from './documents';
import { documentTitleSchema, idSchema, isoDateTimeSchema } from './primitives';
import { workItemParticipantSchema, workItemStatusSchema } from './work-items';

/**
 * Proposed changes (issue #141, ADR-070).
 *
 * A changeset is what an agent hands in instead of writing: a list of page
 * changes, each resolved against the page as it stood when it was proposed and
 * shown as a block diff. Nothing reaches a page until a person applies a
 * change, one by one or all at once, and applying is an ordinary write with an
 * ordinary snapshot in front of it. A change whose page has moved since is
 * never applied: it is stale, and the agent proposes again.
 */

export const CHANGESET_STATUSES = [
  'draft',
  'ready',
  'partially_applied',
  'applied',
  'rejected',
  'stale',
] as const;
export const changesetStatusSchema = z.enum(CHANGESET_STATUSES);
export type ChangesetStatus = z.infer<typeof changesetStatusSchema>;

export const CHANGESET_CHANGE_KINDS = ['block', 'section', 'patch', 'page', 'create'] as const;
export const changesetChangeKindSchema = z.enum(CHANGESET_CHANGE_KINDS);
export type ChangesetChangeKind = z.infer<typeof changesetChangeKindSchema>;

export const changesetChangeStatusSchema = z.enum(['pending', 'applied', 'rejected', 'stale']);
export type ChangesetChangeStatus = z.infer<typeof changesetChangeStatusSchema>;

export const CHANGESET_MAX_CHANGES = 50;
export const CHANGESET_MESSAGE_MAX_CHARS = 4_000;

const changeMessageSchema = z.string().trim().min(1).max(2_000).optional();

/**
 * One change as it is proposed. The page writes are the narrow write requests
 * of issue #111 without their revision: the revision is the changeset's to
 * keep (`expectedRevision`), and a caller that read the page names the one it
 * read as `expectedYjsUpdatedAt` beside it, which is refused when it is
 * already stale.
 */
export const proposeChangeSchema = z.discriminatedUnion('kind', [
  documentBlockWriteRequestSchema.extend({
    kind: z.literal('block'),
    documentId: idSchema,
    message: changeMessageSchema,
  }),
  documentSectionWriteRequestSchema.extend({
    kind: z.literal('section'),
    documentId: idSchema,
    message: changeMessageSchema,
  }),
  documentPatchRequestSchema.extend({
    kind: z.literal('patch'),
    documentId: idSchema,
    message: changeMessageSchema,
  }),
  z.object({
    kind: z.literal('page'),
    documentId: idSchema,
    markdown: z.string().max(2_000_000),
    /** `replace` swaps the whole page; `append` adds at the end. */
    mode: z.enum(['replace', 'append']).default('replace'),
    expectedYjsUpdatedAt: isoDateTimeSchema.optional(),
    message: changeMessageSchema,
  }),
  z.object({
    kind: z.literal('create'),
    /** Null or absent: at the top of the workspace. */
    parentId: idSchema.nullable().optional(),
    title: documentTitleSchema,
    markdown: z.string().max(2_000_000),
    message: changeMessageSchema,
  }),
]);
export type ProposeChange = z.infer<typeof proposeChangeSchema>;

/** What a change row stores as its request: the write, without revision or message. */
export type ChangesetChangeRequest = Record<string, unknown>;

export const changesetDiffSchema = z.object({
  /** Only the blocks that differ; unchanged ones are left out. */
  blocks: z.array(documentDiffBlockSchema),
  summary: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    moved: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  }),
  truncated: z.boolean(),
});
export type ChangesetDiff = z.infer<typeof changesetDiffSchema>;

export const changesetChangeSchema = z.object({
  id: idSchema,
  position: z.number().int().nonnegative(),
  kind: changesetChangeKindSchema,
  /** The page it changes; null for a new page, or once the page is gone. */
  documentId: idSchema.nullable(),
  /** The page's title now, or the new page's title. Null when the page is gone. */
  title: z.string().nullable(),
  /** For a new page: where it goes. */
  parentId: idSchema.nullable(),
  message: z.string().nullable(),
  /** The Markdown this change brings, and for a patch the text it replaces. */
  markdown: z.string(),
  oldText: z.string().nullable(),
  /** Where it lands: a block id, a heading, or a mode. For reading, not for sending. */
  target: z.string().nullable(),
  mode: z.string().nullable(),
  diff: changesetDiffSchema,
  status: changesetChangeStatusSchema,
  /**
   * For a pending change: true when it still fits the page, i.e. the page is
   * at the revision the change expects. False means an apply would be refused
   * and mark it stale. Always false for a decided change.
   */
  applicable: z.boolean(),
  baseRevision: isoDateTimeSchema.nullable(),
  expectedRevision: isoDateTimeSchema.nullable(),
  /** The page's revision now; null for a new page or a page that is gone. */
  currentRevision: isoDateTimeSchema.nullable(),
  decidedAt: isoDateTimeSchema.nullable(),
  decidedBy: workItemParticipantSchema.nullable(),
  decisionNote: z.string().nullable(),
  /** Why it went stale, as an error code. */
  errorCode: z.string().nullable(),
  /** The snapshot taken before it was applied; restore it to undo. */
  snapshotId: idSchema.nullable(),
  createdDocumentId: idSchema.nullable(),
});
export type ChangesetChange = z.infer<typeof changesetChangeSchema>;

export const changesetCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
});
export type ChangesetCounts = z.infer<typeof changesetCountsSchema>;

export const changesetSummarySchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  title: z.string(),
  message: z.string().nullable(),
  status: changesetStatusSchema,
  proposedBy: workItemParticipantSchema,
  /** The agent client as it named itself. Shown, never trusted. */
  agentLabel: z.string().nullable(),
  workItem: z.object({ id: idSchema, title: z.string(), status: workItemStatusSchema }).nullable(),
  runId: idSchema.nullable(),
  revisesId: idSchema.nullable(),
  /** The attention item handing it in raised; null for a draft. */
  attentionItemId: idSchema.nullable(),
  counts: changesetCountsSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  submittedAt: isoDateTimeSchema.nullable(),
  closedAt: isoDateTimeSchema.nullable(),
});
export type ChangesetSummary = z.infer<typeof changesetSummarySchema>;

export const changesetDetailSchema = changesetSummarySchema.extend({
  changes: z.array(changesetChangeSchema),
  /** Later proposals that rework this one. */
  revisionIds: z.array(idSchema),
});
export type ChangesetDetail = z.infer<typeof changesetDetailSchema>;

export const changesetResponseSchema = z.object({ changeset: changesetDetailSchema });
export type ChangesetResponse = z.infer<typeof changesetResponseSchema>;

export const listChangesetsQuerySchema = z.object({
  /** `open` is a draft or anything with a pending change; `closed` the rest. */
  state: z.enum(['open', 'closed', 'all']).default('open'),
  workItemId: idSchema.optional(),
  /** `me`: the ones the caller proposed. */
  proposedBy: z.literal('me').optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListChangesetsQuery = z.infer<typeof listChangesetsQuerySchema>;

export const changesetListResponseSchema = z.object({
  changesets: z.array(changesetSummarySchema),
  truncated: z.boolean(),
});
export type ChangesetListResponse = z.infer<typeof changesetListResponseSchema>;

/**
 * A new draft. `revisesId` names an earlier proposal this one reworks after
 * its review; `workItemId` the work it is part of. A first `change` may come
 * along, which is how one call both starts a set and puts something in it.
 */
export const createChangesetRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  message: z.string().trim().min(1).max(CHANGESET_MESSAGE_MAX_CHARS).optional(),
  workItemId: idSchema.optional(),
  revisesId: idSchema.optional(),
  change: proposeChangeSchema.optional(),
});
export type CreateChangesetRequest = z.infer<typeof createChangesetRequestSchema>;

export const addChangesetChangeResponseSchema = z.object({
  changeset: changesetDetailSchema,
  /** The change just added. */
  changeId: idSchema,
});
export type AddChangesetChangeResponse = z.infer<typeof addChangesetChangeResponseSchema>;

/**
 * Handing a draft in. It is frozen from here on and waits for a person: one
 * attention item says so. On a work item, `review` (default true) moves the
 * work into `review` and pauses the run that handed it in; the decision
 * carries the run on (ADR-068).
 */
export const submitChangesetRequestSchema = z.object({
  review: z.boolean().optional(),
  /** What the reviewer needs to know beyond the message. */
  context: z.string().trim().min(1).max(8_000).optional(),
});
export type SubmitChangesetRequest = z.infer<typeof submitChangesetRequestSchema>;

/**
 * Applying or rejecting. Without `changeIds`, every pending change. A change
 * that no longer fits its page is not applied but marked stale, and the
 * answer says so; the others go on.
 */
export const decideChangesetRequestSchema = z.object({
  changeIds: z.array(idSchema).min(1).max(CHANGESET_MAX_CHANGES).optional(),
  note: z.string().trim().min(1).max(2_000).optional(),
});
export type DecideChangesetRequest = z.infer<typeof decideChangesetRequestSchema>;

export const changesetDecisionOutcomeSchema = z.object({
  changeId: z.string(),
  outcome: z.enum(['applied', 'rejected', 'stale', 'failed', 'skipped']),
  /** For `stale` and `failed`: the error code the write answered with. */
  errorCode: z.string().nullable(),
  message: z.string().nullable(),
});
export type ChangesetDecisionOutcome = z.infer<typeof changesetDecisionOutcomeSchema>;

export const changesetDecisionResponseSchema = z.object({
  changeset: changesetDetailSchema,
  outcomes: z.array(changesetDecisionOutcomeSchema),
});
export type ChangesetDecisionResponse = z.infer<typeof changesetDecisionResponseSchema>;

/**
 * The status a set of changes adds up to (ADR-070). Pure, so the service, the
 * tests and anybody reading the rule see the same one.
 *
 * A draft is a draft until it is handed in. Afterwards: anything pending is
 * `ready`, or `partially_applied` once something landed; with nothing
 * pending, all applied is `applied`, some applied `partially_applied`, none
 * applied but something stale `stale`, and otherwise `rejected`.
 */
export function changesetStatusOf(input: {
  submitted: boolean;
  statuses: readonly ChangesetChangeStatus[];
}): ChangesetStatus {
  if (!input.submitted) return 'draft';
  const count = (status: ChangesetChangeStatus) =>
    input.statuses.filter((entry) => entry === status).length;
  const applied = count('applied');
  if (count('pending') > 0) return applied > 0 ? 'partially_applied' : 'ready';
  if (applied > 0) return applied === input.statuses.length ? 'applied' : 'partially_applied';
  return count('stale') > 0 ? 'stale' : 'rejected';
}
