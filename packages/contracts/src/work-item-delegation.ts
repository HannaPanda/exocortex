import { z } from 'zod';

import { aiReasoningLevelSchema } from './ai-models';
import { aiWriteModeSchema } from './ai-trust';
import { idSchema, isoDateTimeSchema } from './primitives';
import {
  WORK_ITEM_GOAL_MAX_CHARS,
  WORK_ITEM_MAX_CRITERIA,
  WORK_ITEM_MAX_REFS,
  workItemAssigneeInputSchema,
  workItemAwaitingSchema,
  workItemCriterionSchema,
  workItemDetailSchema,
  workItemParticipantSchema,
  workItemPrioritySchema,
  workItemRefSchema,
  workItemRunSchema,
  workItemStatusSchema,
} from './work-items';

/**
 * Delegation (issue #144, ADR-072).
 *
 * A subtask is an ordinary work item with a parent: its own context, profile,
 * budget, runs, status, result and questions. Nothing about it is a mechanism
 * of the agent loop. What this file adds is the three moves a parent makes
 * with its children -- hand a part on, read what came back, wait for it --
 * and the shape of what comes back: the distilled result, never a transcript,
 * so a parent with ten children does not drown in their conversations.
 */

/** How many children a parent may hand on in one piece of work. */
export const WORK_ITEM_MAX_CHILDREN = 50;
/** The default and the ceiling for one child's result in the compact read. */
export const CHILD_RESULT_DEFAULT_CHARS = 2_000;
export const CHILD_RESULT_MAX_CHARS = 10_000;
/** What the compact read hands back at most, across all children. */
export const CHILD_RESULTS_TOTAL_CHARS = 24_000;

/**
 * Handing a part of the work on.
 *
 * The assignee defaults to the built-in AI, and a child the built-in AI holds
 * is started at once unless `start` is false. `budgetMicroUsd` is carved out of
 * what the parent has left and can never exceed it; left out, the child gets
 * that remainder. `writeMode` is held to the stricter of what is asked, the
 * parent's own and the caller's, so a child can never write more than the
 * work it is part of. `expectedResult` says what shape the answer should
 * take ("a table of providers with prices"), which the child is told.
 */
export const delegateWorkRequestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  goal: z.string().trim().min(1).max(WORK_ITEM_GOAL_MAX_CHARS),
  expectedResult: z.string().trim().min(1).max(2_000).optional(),
  assignee: workItemAssigneeInputSchema.optional(),
  acceptanceCriteria: z.array(workItemCriterionSchema).max(WORK_ITEM_MAX_CRITERIA).optional(),
  contextDocumentIds: z.array(idSchema).max(WORK_ITEM_MAX_REFS).optional(),
  budgetMicroUsd: z.number().int().min(0).max(1_000_000_000).optional(),
  writeMode: aiWriteModeSchema.optional(),
  /**
   * A role for the child. Anybody may choose one that is no looser than the
   * parent's; another takes a person or a token that may write (ADR-071).
   */
  agentProfileId: idSchema.optional(),
  priority: workItemPrioritySchema.optional(),
  dueAt: isoDateTimeSchema.optional(),
  start: z.boolean().optional(),
  instructions: z.string().trim().max(4_000).optional(),
  modelSlug: z.string().min(1).max(200).optional(),
  reasoningLevel: aiReasoningLevelSchema.optional(),
});
export type DelegateWorkRequest = z.infer<typeof delegateWorkRequestSchema>;

export const delegateWorkResponseSchema = z.object({
  workItem: workItemDetailSchema,
  /** The run started on it, or null when nothing was started. */
  run: workItemRunSchema.nullable(),
  /** Why a requested start did not happen, as an error code; the child exists either way. */
  startRefused: z.string().nullable(),
});
export type DelegateWorkResponse = z.infer<typeof delegateWorkResponseSchema>;

/** One child as its parent reads it: what came out, not how. */
export const workItemChildResultSchema = z.object({
  id: idSchema,
  title: z.string(),
  status: workItemStatusSchema,
  statusReason: z.string().nullable(),
  assignee: workItemParticipantSchema.nullable(),
  /** True once it is in review or closed: the parent may act on it. */
  returned: z.boolean(),
  result: z.string().nullable(),
  /** True when `result` was cut to the budget; `exo_work_item_get` reads it whole. */
  resultTruncated: z.boolean(),
  resultRefs: z.array(workItemRefSchema),
  criteriaMet: z.number().int(),
  criteriaTotal: z.number().int(),
  spentMicroUsd: z.number().int(),
  latestRun: z
    .object({ id: idSchema, status: z.string(), errorCode: z.string().nullable() })
    .nullable(),
  closedAt: isoDateTimeSchema.nullable(),
});
export type WorkItemChildResult = z.infer<typeof workItemChildResultSchema>;

export const childResultsQuerySchema = z.object({
  /** Comma-separated child ids; all children when left out. */
  childIds: z
    .string()
    .max(WORK_ITEM_MAX_CHILDREN * 40)
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .optional(),
  maxChars: z.coerce.number().int().min(200).max(CHILD_RESULT_MAX_CHARS).optional(),
});
export type ChildResultsQuery = z.infer<typeof childResultsQuerySchema>;

export const childResultsResponseSchema = z.object({
  workItemId: idSchema,
  children: z.array(workItemChildResultSchema),
  awaiting: workItemAwaitingSchema.nullable(),
});
export type ChildResultsResponse = z.infer<typeof childResultsResponseSchema>;

/**
 * Waiting for children. All open children when `childIds` is left out. A run
 * of the built-in AI that waits ends after the call; the children coming back
 * carry it on in its own conversation with their results.
 */
export const awaitChildrenRequestSchema = z.object({
  childIds: z.array(idSchema).min(1).max(WORK_ITEM_MAX_CHILDREN).optional(),
});
export type AwaitChildrenRequest = z.infer<typeof awaitChildrenRequestSchema>;

export const awaitChildrenResponseSchema = z.object({
  /** False when every named child is back already: nothing to wait for. */
  waiting: z.boolean(),
  awaiting: workItemAwaitingSchema.nullable(),
  /** Present when nothing is waited for: what the children brought back. */
  results: z.array(workItemChildResultSchema),
});
export type AwaitChildrenResponse = z.infer<typeof awaitChildrenResponseSchema>;
