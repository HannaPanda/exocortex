import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';
import {
  workItemParticipantSchema,
  workItemPrioritySchema,
  workItemStatusSchema,
} from './work-items';

/**
 * What needs a person (issue #139, ADR-067).
 *
 * An attention item is an open need for somebody's action, never a piece of
 * information: a decision, an approval, a result to review, a blocked piece of
 * work, a failed run somebody has to decide about. What merely happened
 * belongs to the activity, the journal and the notifications. An item is
 * raised once and settled once, and it never reopens.
 */

export const ATTENTION_KINDS = [
  'decision',
  'approval',
  'review',
  'blocked',
  'budget',
  'run_failed',
  'conflict',
  'information',
] as const;
export const attentionKindSchema = z.enum(ATTENTION_KINDS);
export type AttentionKind = z.infer<typeof attentionKindSchema>;

/**
 * The kinds an agent may raise by asking. `blocked` and `run_failed` come only
 * from a work item's own state. `review` may be asked for (issue #140), but
 * only about a work item, and asking is the same as moving that item into
 * `review`: the state raises the one review item and the request's context
 * rides on it, so the list of what waits for review is still the list of
 * items actually in review.
 */
export const REQUESTABLE_ATTENTION_KINDS = [
  'decision',
  'approval',
  'review',
  'budget',
  'conflict',
  'information',
] as const satisfies readonly AttentionKind[];
export const requestableAttentionKindSchema = z.enum(REQUESTABLE_ATTENTION_KINDS);
export type RequestableAttentionKind = z.infer<typeof requestableAttentionKindSchema>;

/**
 * The requestable kinds that are a question the work waits on. Raising one on
 * an open work item moves it to `waiting_for_human`, and answering the last
 * one moves it back to `queued`; `conflict` is about pages rather than about
 * the work going on.
 */
export const QUESTION_ATTENTION_KINDS: readonly AttentionKind[] = [
  'decision',
  'approval',
  'budget',
  'information',
];

export const attentionStatusSchema = z.enum(['open', 'resolved', 'obsolete']);
export type AttentionStatus = z.infer<typeof attentionStatusSchema>;

export const attentionNoteModeSchema = z.enum(['none', 'optional', 'required']);
export type AttentionNoteMode = z.infer<typeof attentionNoteModeSchema>;

/**
 * The option ids a system item offers, each with an effect on its work item.
 *
 * `accept` closes a review as done, `return` sends it back to working with the
 * note as its reason, `answer` records the note and puts a waiting item back
 * in the queue, `unblock` does the same for a blocked one, `retry` starts a new
 * run, `give_up` marks the work failed. Their labels come from the message
 * catalogue, because the reader's language is not the writer's.
 */
export const SYSTEM_ATTENTION_OPTIONS = [
  'accept',
  'return',
  'answer',
  'unblock',
  'retry',
  'give_up',
] as const;
export type SystemAttentionOption = (typeof SYSTEM_ATTENTION_OPTIONS)[number];

const optionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lower-case letters, digits, "_" and "-"');

/** One action a person can take without leaving the inbox. */
export const attentionOptionSchema = z.object({
  id: optionIdSchema,
  /** The words on the button. Null for a system option, whose words the reader's catalogue has. */
  label: z.string().trim().min(1).max(80).nullable(),
});
export type AttentionOption = z.infer<typeof attentionOptionSchema>;

export const ATTENTION_MAX_OPTIONS = 6;
export const ATTENTION_NOTE_MAX_CHARS = 4_000;
/** Context and working state a checkpoint carries (issue #140). */
export const ATTENTION_CONTEXT_MAX_CHARS = 8_000;
export const ATTENTION_SUBJECT_MAX_PAGES = 10;

/**
 * What an approval is bound to (issue #140, ADR-068): pages at the revision
 * the asker saw, `DocumentContent.yjsUpdatedAt`, the same value a write sends
 * back as `expectedYjsUpdatedAt`. An answer given after one of them changed
 * does not approve anything; and the run carried on with the approval writes
 * with that revision, so a change after the answer is refused by the write
 * itself. A changeset (issue #141, ADR-070) is the second member.
 */
export const attentionSubjectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pages'),
    pages: z
      .array(z.object({ documentId: idSchema, revision: isoDateTimeSchema }))
      .min(1)
      .max(ATTENTION_SUBJECT_MAX_PAGES),
  }),
  /**
   * A handed-in changeset (issue #141, ADR-070), bound by the hash of its
   * changes the way a page is bound by its revision. The pages the changes
   * touch are not bound here: each change carries its own revision, and a
   * change whose page moved is stale rather than approved.
   */
  z.object({
    kind: z.literal('changeset'),
    changesetId: idSchema,
    hash: z.string(),
  }),
]);
export type AttentionSubject = z.infer<typeof attentionSubjectSchema>;

/** A subject page as a reader sees it, with whether it moved since the question. */
export const attentionSubjectPageSchema = z.object({
  documentId: idSchema,
  revision: isoDateTimeSchema,
  /** Null when the page is gone or the reader cannot see it. */
  title: z.string().nullable(),
  /** True when the page's content is no longer at `revision`, or the page is gone. */
  changed: z.boolean(),
});
export type AttentionSubjectPage = z.infer<typeof attentionSubjectPageSchema>;

/** What settled an item, as facts. */
export const attentionResolutionSchema = z.object({
  optionId: z.string().optional(),
  note: z.string().optional(),
  /** The status the work item moved to, when that is what settled it. */
  workItemStatus: workItemStatusSchema.optional(),
  /** The run a retry started, or the newer run that replaced a failed one. */
  runId: idSchema.optional(),
  /**
   * Why an item became obsolete: `work_item_cancelled`, `work_item_deleted`,
   * `withdrawn`, `superseded`, or `subject_changed` when an approval was
   * answered after what it was bound to had moved (issue #140).
   */
  reason: z.string().optional(),
  /** The run the answer carried the paused work on in (issue #140). */
  resumedRunId: idSchema.optional(),
  /** Why the answer could not carry the work on, as an error code (issue #140). */
  resumeError: z.string().optional(),
});
export type AttentionResolution = z.infer<typeof attentionResolutionSchema>;

export const attentionItemSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  workspaceName: z.string(),
  kind: attentionKindSchema,
  status: attentionStatusSchema,
  title: z.string(),
  reason: z.string().nullable(),
  urgency: workItemPrioritySchema,
  /** Whose inbox it is in; null means anybody in the workspace who manages work. */
  recipientId: idSchema.nullable(),
  raisedBy: workItemParticipantSchema,
  /** The agent client that raised it, as it named itself. Shown, never trusted. */
  agentLabel: z.string().nullable(),
  /** True when the system raised it from a work item's state; its options then have effects. */
  system: z.boolean(),
  workItem: z.object({ id: idSchema, title: z.string(), status: workItemStatusSchema }).nullable(),
  run: z
    .object({
      id: idSchema,
      conversationId: idSchema.nullable(),
      errorCode: z.string().nullable(),
    })
    .nullable(),
  options: z.array(attentionOptionSchema),
  noteMode: attentionNoteModeSchema,
  /** A human checkpoint the work waits on (issue #140); false for one that stops nothing. */
  blocking: z.boolean(),
  /** What a person needs to know to answer. */
  context: z.string().nullable(),
  /** For an approval: exactly what will happen when it is given. */
  action: z.string().nullable(),
  /** The asker's account of where the work stands, handed back with the answer. */
  workState: z.string().nullable(),
  /** The pages an approval is bound to; null when it is bound to none. */
  subject: z.array(attentionSubjectPageSchema).nullable(),
  /** The changeset a review or approval is about (issue #141); null otherwise. */
  changeset: z
    .object({
      id: idSchema,
      title: z.string(),
      status: z.string(),
      pending: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      /** False when the set was altered after it was handed in, or is gone. */
      intact: z.boolean(),
    })
    .nullable(),
  settledAt: isoDateTimeSchema.nullable(),
  settledBy: workItemParticipantSchema.nullable(),
  resolution: attentionResolutionSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type AttentionItem = z.infer<typeof attentionItemSchema>;

export const attentionItemResponseSchema = z.object({ attentionItem: attentionItemSchema });
export type AttentionItemResponse = z.infer<typeof attentionItemResponseSchema>;

/**
 * The list. `scope` says whose: `for_me` is what lands in the caller's inbox
 * (addressed to them, or to nobody in particular in a workspace where they
 * manage work), `raised_by_me` is what the caller asked, which is how an agent
 * finds its answers, and `all` is everything the caller can read.
 */
export const listAttentionQuerySchema = z.object({
  scope: z.enum(['for_me', 'raised_by_me', 'all']).default('for_me'),
  status: z.enum(['open', 'settled', 'all']).default('open'),
  workspaceId: idSchema.optional(),
  workItemId: idSchema.optional(),
  /** The checkpoints the runs of one conversation raised, for the chat (issue #140). */
  conversationId: idSchema.optional(),
  kind: z
    .union([attentionKindSchema, z.array(attentionKindSchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListAttentionQuery = z.infer<typeof listAttentionQuerySchema>;

export const attentionListResponseSchema = z.object({
  attentionItems: z.array(attentionItemSchema),
  /** Open items per kind within the same scope and workspace filter, for the headline. */
  openCounts: z.record(attentionKindSchema, z.number().int()),
  truncated: z.boolean(),
});
export type AttentionListResponse = z.infer<typeof attentionListResponseSchema>;

/**
 * An agent (or a person) asking somebody something.
 *
 * With options, answering means choosing one; without, it means writing the
 * note, so an `information` request should leave `options` empty. `key` makes
 * the request idempotent: asking the same key again while the first is open
 * returns the open one instead of a second.
 *
 * As a human checkpoint (issue #140): `blocking` (default true on a work
 * item, always false without one) makes the work wait and pauses the run that
 * asked; `workState` is handed back verbatim with the answer; an approval
 * names its `action` and may bind itself to pages, at the revision the asker
 * read or, without one, at the revision they are at now.
 */
export const requestAttentionSchema = z
  .object({
    kind: requestableAttentionKindSchema,
    title: z.string().trim().min(1).max(300),
    reason: z.string().trim().max(2_000).optional(),
    urgency: workItemPrioritySchema.optional(),
    recipientId: idSchema.nullable().optional(),
    workItemId: idSchema.optional(),
    options: z
      .array(attentionOptionSchema.extend({ label: z.string().trim().min(1).max(80) }))
      .max(ATTENTION_MAX_OPTIONS)
      .optional(),
    noteMode: attentionNoteModeSchema.optional(),
    key: z.string().trim().min(1).max(120).optional(),
    blocking: z.boolean().optional(),
    context: z.string().trim().min(1).max(ATTENTION_CONTEXT_MAX_CHARS).optional(),
    action: z.string().trim().min(1).max(2_000).optional(),
    workState: z.string().trim().min(1).max(ATTENTION_CONTEXT_MAX_CHARS).optional(),
    subjectPages: z
      .array(z.object({ documentId: idSchema, revision: isoDateTimeSchema.optional() }))
      .min(1)
      .max(ATTENTION_SUBJECT_MAX_PAGES)
      .optional(),
  })
  .refine((value) => value.kind !== 'approval' || value.action !== undefined, {
    message: 'An approval names the action it approves',
    path: ['action'],
  })
  .refine((value) => value.subjectPages === undefined || value.kind === 'approval', {
    message: 'Only an approval is bound to pages',
    path: ['subjectPages'],
  })
  .refine((value) => value.kind !== 'review' || value.workItemId !== undefined, {
    message: 'A review is asked about a work item',
    path: ['workItemId'],
  })
  .refine(
    (value) =>
      new Set((value.options ?? []).map((option) => option.id)).size ===
      (value.options ?? []).length,
    { message: 'Option ids must be unique', path: ['options'] },
  );
export type RequestAttention = z.infer<typeof requestAttentionSchema>;

export const resolveAttentionSchema = z.object({
  optionId: optionIdSchema.optional(),
  note: z.string().trim().min(1).max(ATTENTION_NOTE_MAX_CHARS).optional(),
});
export type ResolveAttention = z.infer<typeof resolveAttentionSchema>;

export const withdrawAttentionSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type WithdrawAttention = z.infer<typeof withdrawAttentionSchema>;
