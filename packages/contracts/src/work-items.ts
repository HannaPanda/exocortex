import { z } from 'zod';

import { agentProfileRefSchema } from './agent-profiles';
import { aiRunStatusSchema } from './ai';
import { aiReasoningLevelSchema } from './ai-models';
import { aiWriteModeSchema } from './ai-trust';
import { idSchema, isoDateTimeSchema } from './primitives';
import { workflowOutputFieldSchema } from './workflow-graph';
import { resultFieldsSchema, structuredResultSchema } from './workflow-result';

/**
 * Delegated work (issue #138, ADR-066).
 *
 * A work item is the durable unit behind a request: "find out X", "tidy up
 * this area", "review what the agent wrote". It is not a run. A run is one
 * attempt at an item, and an item can have none, one or several; its status is
 * what somebody decided, never a mirror of the last run.
 *
 * Both ends are symmetric on purpose. A person can ask an agent, an agent can
 * ask a person, and either can ask their own kind, so there is one model for
 * all four directions rather than an "AI task" beside a to-do list.
 */

export const WORK_ITEM_STATUSES = [
  'queued',
  'working',
  'blocked',
  'waiting_for_human',
  'review',
  'done',
  'failed',
  'cancelled',
] as const;
export const workItemStatusSchema = z.enum(WORK_ITEM_STATUSES);
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;

/** The statuses that close an item. Leaving one of them reopens it. */
export const CLOSED_WORK_ITEM_STATUSES: readonly WorkItemStatus[] = ['done', 'failed', 'cancelled'];

export function isClosedWorkItemStatus(status: WorkItemStatus): boolean {
  return CLOSED_WORK_ITEM_STATUSES.includes(status);
}

export const WORK_ITEM_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const workItemPrioritySchema = z.enum(WORK_ITEM_PRIORITIES);
export type WorkItemPriority = z.infer<typeof workItemPrioritySchema>;

/**
 * `human` and `agent` are accounts; which one a request was is read from the
 * agent session header, not from the account. `assistant` is the built-in AI,
 * which has no account and acts for a person: as an assignee it names nobody,
 * as a requester or an actor `userId` is the person it acted for.
 */
export const workItemParticipantKindSchema = z.enum(['human', 'agent', 'assistant']);
export type WorkItemParticipantKind = z.infer<typeof workItemParticipantKindSchema>;

export const workItemParticipantSchema = z.object({
  kind: workItemParticipantKindSchema,
  userId: idSchema.nullable(),
  /** The account's display name, or null for the assistant and for a deleted account. */
  name: z.string().nullable(),
});
export type WorkItemParticipant = z.infer<typeof workItemParticipantSchema>;

/**
 * Who should do the work, as a request names it.
 *
 * `null` in a request means nobody; the assistant needs no id, and a person or
 * an agent account must be a member of the item's workspace.
 */
export const workItemAssigneeInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assistant') }),
  z.object({ kind: z.enum(['human', 'agent']), userId: idSchema }),
]);
export type WorkItemAssigneeInput = z.infer<typeof workItemAssigneeInputSchema>;

export const workItemCriterionSchema = z.object({
  text: z.string().trim().min(1).max(500),
  met: z.boolean().default(false),
});
export type WorkItemCriterion = z.infer<typeof workItemCriterionSchema>;

/** Hard limits, so one item cannot become a document of its own. */
export const WORK_ITEM_GOAL_MAX_CHARS = 20_000;
export const WORK_ITEM_RESULT_MAX_CHARS = 50_000;
export const WORK_ITEM_MAX_CRITERIA = 30;
export const WORK_ITEM_MAX_REFS = 50;

const titleSchema = z.string().trim().min(1).max(300);
const goalSchema = z.string().trim().min(1).max(WORK_ITEM_GOAL_MAX_CHARS);
const statusReasonSchema = z.string().trim().max(1_000);
const criteriaSchema = z.array(workItemCriterionSchema).max(WORK_ITEM_MAX_CRITERIA);
const refIdsSchema = z.array(idSchema).max(WORK_ITEM_MAX_REFS);
/** Millionths of a dollar, the unit every cost column here uses. */
const budgetSchema = z.number().int().min(0).max(1_000_000_000);

export const workItemRefSchema = z.object({
  documentId: idSchema,
  title: z.string(),
});
export type WorkItemRef = z.infer<typeof workItemRefSchema>;

export const workItemSummarySchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  title: z.string(),
  status: workItemStatusSchema,
  statusReason: z.string().nullable(),
  priority: workItemPrioritySchema,
  requester: workItemParticipantSchema,
  assignee: workItemParticipantSchema.nullable(),
  dueAt: isoDateTimeSchema.nullable(),
  parentId: idSchema.nullable(),
  childCount: z.number().int(),
  runCount: z.number().int(),
  criteriaMet: z.number().int(),
  criteriaTotal: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  closedAt: isoDateTimeSchema.nullable(),
});
export type WorkItemSummary = z.infer<typeof workItemSummarySchema>;

/** One attempt at an item, as far as the item needs to know about it. */
export const workItemRunSchema = z.object({
  id: idSchema,
  status: aiRunStatusSchema,
  model: z.string(),
  conversationId: idSchema.nullable(),
  createdById: idSchema,
  createdAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
  /** Measured or, failing that, estimated cost; null when the run reported neither. */
  costMicroUsd: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  /** The profile the run worked under (issue #143), as it was when the run started. */
  agentProfile: z
    .object({ id: idSchema.nullable(), name: z.string(), revision: z.number().int() })
    .nullable(),
});
export type WorkItemRun = z.infer<typeof workItemRunSchema>;

export const WORK_ITEM_EVENT_KINDS = [
  'created',
  'updated',
  'status_changed',
  'assigned',
  'run_started',
  'result_recorded',
  'note',
  'attention_raised',
  'attention_resolved',
  'run_resumed',
  'resume_failed',
  'checkpoint_recorded',
  'delegated',
  'children_awaited',
  'children_returned',
  'structured_result_recorded',
] as const;
export const workItemEventKindSchema = z.enum(WORK_ITEM_EVENT_KINDS);
export type WorkItemEventKind = z.infer<typeof workItemEventKindSchema>;

/**
 * What an event says, as facts a reader renders in its own language.
 *
 * Every member optional because each kind uses a different handful: a status
 * change carries `from`, `to` and perhaps `reason`, an update the list of
 * `fields` it touched, an assignment the new `assignee`, a run start its
 * `runId`.
 */
export const workItemEventDataSchema = z.object({
  from: workItemStatusSchema.optional(),
  to: workItemStatusSchema.optional(),
  reason: z.string().optional(),
  fields: z.array(z.string()).optional(),
  assignee: workItemParticipantSchema.nullable().optional(),
  runId: idSchema.optional(),
  /** The attention item a person was asked, or answered (issue #139). */
  attentionItemId: idSchema.optional(),
  attentionKind: z.string().optional(),
  optionId: z.string().optional(),
  /**
   * The checkpoint a line is about (issue #142): the one recorded, or the one
   * a run was started from.
   */
  checkpointId: idSchema.optional(),
  trigger: z.string().optional(),
  /** The child a delegation created (issue #144). */
  childId: idSchema.optional(),
  /** The children a wait names, or the ones that came back. */
  childIds: z.array(idSchema).optional(),
});
export type WorkItemEventData = z.infer<typeof workItemEventDataSchema>;

export const workItemEventSchema = z.object({
  id: idSchema,
  kind: workItemEventKindSchema,
  actor: workItemParticipantSchema,
  /** The agent client that made the change, as it named itself. Shown, never trusted. */
  agentLabel: z.string().nullable(),
  data: workItemEventDataSchema,
  note: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type WorkItemEvent = z.infer<typeof workItemEventSchema>;

/**
 * How the children of a piece of work stand (issue #144), counted by what
 * their status means for the parent: still running, waiting on somebody,
 * back for review, or closed one way or the other.
 */
export const workItemChildProgressSchema = z.object({
  total: z.number().int(),
  open: z.number().int(),
  waiting: z.number().int(),
  review: z.number().int(),
  done: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
});
export type WorkItemChildProgress = z.infer<typeof workItemChildProgressSchema>;

/** What a piece of work waits for (issue #144): children, until each has come back. */
export const workItemAwaitingSchema = z.object({
  childIds: z.array(idSchema),
  /** The ones of them that are not back yet. */
  pendingChildIds: z.array(idSchema),
  /** The run that paused to wait, when a run of the built-in AI did. */
  runId: idSchema.nullable(),
  since: isoDateTimeSchema,
});
export type WorkItemAwaiting = z.infer<typeof workItemAwaitingSchema>;

export const workItemDetailSchema = workItemSummarySchema.extend({
  goal: z.string(),
  acceptanceCriteria: z.array(workItemCriterionSchema),
  result: z.string().nullable(),
  budgetMicroUsd: z.number().int().nullable(),
  /**
   * How a run of the built-in AI on this work may change things (issue
   * #141); null inherits the workspace's `ai.writeMode`, and the stricter of
   * the two applies.
   */
  writeMode: aiWriteModeSchema.nullable(),
  /**
   * The agent profile its runs use (issue #143): the item's own, or the
   * workspace's default when it names none (`inherited`), or null for none.
   */
  agentProfile: agentProfileRefSchema.nullable(),
  /**
   * The budget that actually holds: the stricter of the item's own and its
   * profile's per-task budget.
   */
  effectiveBudgetMicroUsd: z.number().int().nullable(),
  /** What the linked runs have cost so far, measured where known, estimated otherwise. */
  spentMicroUsd: z.number().int(),
  /**
   * What this work and everything delegated below it has cost (issue #144).
   * A budget holds for the whole subtree, so delegating cannot escape it.
   */
  subtreeSpentMicroUsd: z.number().int(),
  /**
   * What is left to spend: the smallest remainder of this item's budget and
   * every ancestor's, each measured against its own subtree. Null when no
   * budget applies anywhere above; zero or less refuses a new run.
   */
  budgetRemainingMicroUsd: z.number().int().nullable(),
  /** The item whose budget is the tight one, when that is an ancestor. */
  budgetLimitedBy: z.object({ id: idSchema, title: z.string() }).nullable(),
  childProgress: workItemChildProgressSchema,
  awaiting: workItemAwaitingSchema.nullable(),
  parent: z.object({ id: idSchema, title: z.string() }).nullable(),
  contextRefs: z.array(workItemRefSchema),
  resultRefs: z.array(workItemRefSchema),
  children: z.array(workItemSummarySchema),
  runs: z.array(workItemRunSchema),
  events: z.array(workItemEventSchema),
  /** How many working states were recorded (issue #142); read them with the checkpoint list. */
  checkpointCount: z.number().int(),
  latestCheckpointAt: isoDateTimeSchema.nullable(),
  /**
   * The fields this work promises to fill in (issue #162); empty when it
   * promises none. Set when the work is created, by a workflow's agent node
   * or by whoever asked for it, and not changed afterwards: a workflow
   * branches on them.
   */
  resultFields: z.array(workflowOutputFieldSchema),
  /** The values, checked against `resultFields` whenever they are written. */
  structuredResult: structuredResultSchema.nullable(),
  /** The workflow node this work was created by, when one was. */
  workflow: z.object({ workflowId: idSchema, runId: idSchema, nodeId: z.string() }).nullable(),
});
export type WorkItemDetail = z.infer<typeof workItemDetailSchema>;

export const workItemResponseSchema = z.object({ workItem: workItemDetailSchema });
export type WorkItemResponse = z.infer<typeof workItemResponseSchema>;

/**
 * The list's filters. `assignee` takes `me`, `assistant`, `nobody` or an
 * account id; `requester` takes `me` or an account id. `open` defaults to true,
 * because a list of everything ever delegated buries what is still to do.
 */
export const listWorkItemsQuerySchema = z.object({
  status: z
    .union([workItemStatusSchema, z.array(workItemStatusSchema)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  assignee: z.union([z.enum(['me', 'assistant', 'nobody']), idSchema]).optional(),
  requester: z.union([z.literal('me'), idSchema]).optional(),
  parentId: z.union([z.literal('root'), idSchema]).optional(),
  open: z
    .enum(['true', 'false', 'all'])
    .default('true')
    .transform((value) => (value === 'all' ? null : value === 'true')),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListWorkItemsQuery = z.infer<typeof listWorkItemsQuerySchema>;

export const workItemListResponseSchema = z.object({
  workItems: z.array(workItemSummarySchema),
  /** True when `limit` cut the list; the caller should narrow the filter. */
  truncated: z.boolean(),
});
export type WorkItemListResponse = z.infer<typeof workItemListResponseSchema>;

export const createWorkItemRequestSchema = z.object({
  title: titleSchema,
  goal: goalSchema,
  priority: workItemPrioritySchema.optional(),
  assignee: workItemAssigneeInputSchema.nullable().optional(),
  acceptanceCriteria: criteriaSchema.optional(),
  contextDocumentIds: refIdsSchema.optional(),
  budgetMicroUsd: budgetSchema.nullable().optional(),
  writeMode: aiWriteModeSchema.nullable().optional(),
  /**
   * The agent profile its runs use (issue #143). Left out, a part of a larger
   * item takes its parent's; null uses the workspace's default.
   */
  agentProfileId: idSchema.nullable().optional(),
  dueAt: isoDateTimeSchema.nullable().optional(),
  parentId: idSchema.nullable().optional(),
  /**
   * The fields the result has to fill in (issue #162). Only set on creation:
   * handing the work in (`review`) refuses while a required one is missing.
   */
  resultFields: resultFieldsSchema.optional(),
});
export type CreateWorkItemRequest = z.infer<typeof createWorkItemRequestSchema>;

/**
 * A partial update. An absent field is left alone, `null` clears it.
 *
 * The two reference lists replace what is there, because "the pages this was
 * given" is a set somebody edits as a whole; a status change may bring its
 * reason in the same call.
 */
export const updateWorkItemRequestSchema = z
  .object({
    title: titleSchema.optional(),
    goal: goalSchema.optional(),
    status: workItemStatusSchema.optional(),
    statusReason: statusReasonSchema.nullable().optional(),
    priority: workItemPrioritySchema.optional(),
    assignee: workItemAssigneeInputSchema.nullable().optional(),
    acceptanceCriteria: criteriaSchema.optional(),
    result: z.string().trim().max(WORK_ITEM_RESULT_MAX_CHARS).nullable().optional(),
    /**
     * Replaces the structured result as a whole (issue #162); null clears it.
     * Checked against the item's `resultFields`: an undeclared field or a
     * wrong type is refused with `work_item_result_invalid`.
     */
    structuredResult: structuredResultSchema.nullable().optional(),
    contextDocumentIds: refIdsSchema.optional(),
    resultDocumentIds: refIdsSchema.optional(),
    budgetMicroUsd: budgetSchema.nullable().optional(),
    /**
     * Only a person, or a token that may write, may loosen it (issue #141):
     * a run that could lift its own mode would not be held to it.
     */
    writeMode: aiWriteModeSchema.nullable().optional(),
    /** Changed only by a person or a token that may write, like `writeMode`. */
    agentProfileId: idSchema.nullable().optional(),
    dueAt: isoDateTimeSchema.nullable().optional(),
    parentId: idSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update' });
export type UpdateWorkItemRequest = z.infer<typeof updateWorkItemRequestSchema>;

export const addWorkItemNoteRequestSchema = z.object({
  note: z.string().trim().min(1).max(4_000),
});
export type AddWorkItemNoteRequest = z.infer<typeof addWorkItemNoteRequestSchema>;

/**
 * Starting an attempt with the built-in AI.
 *
 * The run gets a conversation of its own whose first message is written from
 * the item (goal, criteria, context pages, its id), so the transcript says
 * what was asked and a later run can continue it. `instructions` is added
 * below that, for "this time, look at the attachments first".
 *
 * `fromCheckpoint` (issue #142) carries the work on from a recorded working
 * state: `latest`, the default, uses the newest one when there is one;
 * `none` starts from the goal alone; an id names an older one. The model may
 * be another than the one the work was started with.
 */
export const startWorkItemRunRequestSchema = z.object({
  instructions: z.string().trim().max(4_000).optional(),
  modelSlug: z.string().min(1).max(200).optional(),
  reasoningLevel: aiReasoningLevelSchema.optional(),
  fromCheckpoint: z.union([z.enum(['latest', 'none']), idSchema]).optional(),
});
export type StartWorkItemRunRequest = z.infer<typeof startWorkItemRunRequestSchema>;

export const startWorkItemRunResponseSchema = z.object({
  run: workItemRunSchema,
  conversationId: idSchema,
  /** The checkpoint the run carries on from, or null when it starts from the goal. */
  checkpointId: idSchema.nullable(),
  workItem: workItemDetailSchema,
});
export type StartWorkItemRunResponse = z.infer<typeof startWorkItemRunResponseSchema>;

export const deleteWorkItemResponseSchema = z.object({
  deleted: z.literal(true),
  /** Children that now stand on their own, because their parent is gone. */
  detachedChildren: z.number().int(),
});
export type DeleteWorkItemResponse = z.infer<typeof deleteWorkItemResponseSchema>;
