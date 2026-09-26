import { z } from 'zod';

import { aiRunStatusSchema } from './ai';
import { aiReasoningLevelSchema } from './ai-models';
import { idSchema, isoDateTimeSchema } from './primitives';

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

export const workItemDetailSchema = workItemSummarySchema.extend({
  goal: z.string(),
  acceptanceCriteria: z.array(workItemCriterionSchema),
  result: z.string().nullable(),
  budgetMicroUsd: z.number().int().nullable(),
  /** What the linked runs have cost so far, measured where known, estimated otherwise. */
  spentMicroUsd: z.number().int(),
  parent: z.object({ id: idSchema, title: z.string() }).nullable(),
  contextRefs: z.array(workItemRefSchema),
  resultRefs: z.array(workItemRefSchema),
  children: z.array(workItemSummarySchema),
  runs: z.array(workItemRunSchema),
  events: z.array(workItemEventSchema),
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
  dueAt: isoDateTimeSchema.nullable().optional(),
  parentId: idSchema.nullable().optional(),
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
    contextDocumentIds: refIdsSchema.optional(),
    resultDocumentIds: refIdsSchema.optional(),
    budgetMicroUsd: budgetSchema.nullable().optional(),
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
 */
export const startWorkItemRunRequestSchema = z.object({
  instructions: z.string().trim().max(4_000).optional(),
  modelSlug: z.string().min(1).max(200).optional(),
  reasoningLevel: aiReasoningLevelSchema.optional(),
});
export type StartWorkItemRunRequest = z.infer<typeof startWorkItemRunRequestSchema>;

export const startWorkItemRunResponseSchema = z.object({
  run: workItemRunSchema,
  conversationId: idSchema,
  workItem: workItemDetailSchema,
});
export type StartWorkItemRunResponse = z.infer<typeof startWorkItemRunResponseSchema>;

export const deleteWorkItemResponseSchema = z.object({
  deleted: z.literal(true),
  /** Children that now stand on their own, because their parent is gone. */
  detachedChildren: z.number().int(),
});
export type DeleteWorkItemResponse = z.infer<typeof deleteWorkItemResponseSchema>;
