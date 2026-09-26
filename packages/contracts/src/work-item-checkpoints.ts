import { z } from 'zod';

import { attentionKindSchema, attentionStatusSchema } from './attention';
import { idSchema, isoDateTimeSchema } from './primitives';
import { workItemParticipantSchema } from './work-items';

/**
 * Where a piece of work stands (issue #142, ADR-069).
 *
 * A checkpoint answers "what am I doing, what is done and what is left" for
 * one work item, so a later run can carry the work on from it instead of
 * reading the old transcript and guessing. That later run may use another
 * model or another provider; nothing here names either as a requirement.
 *
 * It is not memory. Memory is what an agent should know about a person or a
 * project for good; a checkpoint is the state of one task and is of no use
 * once the task is closed.
 */

/**
 * Why it was recorded. The worker of the task says one of the first five;
 * `run_interrupted` is eXocortex's own, written when a run behind the work
 * ended without finishing it (a failure, a timeout, a lost worker, a cancel).
 */
export const WORK_CHECKPOINT_TRIGGERS = [
  'step',
  'pause',
  'waiting_for_human',
  'external_wait',
  'budget',
  'run_interrupted',
] as const;
export const workCheckpointTriggerSchema = z.enum(WORK_CHECKPOINT_TRIGGERS);
export type WorkCheckpointTrigger = z.infer<typeof workCheckpointTriggerSchema>;

/** The triggers a caller may name; the last one is eXocortex's alone. */
export const RECORDABLE_CHECKPOINT_TRIGGERS = [
  'step',
  'pause',
  'waiting_for_human',
  'external_wait',
  'budget',
] as const satisfies readonly WorkCheckpointTrigger[];

export const WORK_CHECKPOINT_STEP_STATUSES = ['done', 'in_progress', 'open'] as const;
export const workCheckpointStepStatusSchema = z.enum(WORK_CHECKPOINT_STEP_STATUSES);
export type WorkCheckpointStepStatus = z.infer<typeof workCheckpointStepStatusSchema>;

export const workCheckpointStepSchema = z.object({
  text: z.string().trim().min(1).max(500),
  status: workCheckpointStepStatusSchema.default('open'),
});
export type WorkCheckpointStep = z.infer<typeof workCheckpointStepSchema>;

/** Hard limits, so a checkpoint stays a state and does not become a report. */
export const WORK_CHECKPOINT_SUMMARY_MAX_CHARS = 8_000;
export const WORK_CHECKPOINT_MAX_STEPS = 50;
export const WORK_CHECKPOINT_MAX_NOTES = 30;
export const WORK_CHECKPOINT_MAX_REFS = 50;

const noteListSchema = z.array(z.string().trim().min(1).max(1_000)).max(WORK_CHECKPOINT_MAX_NOTES);
const lineSchema = z.string().trim().max(1_000);
const planSchema = z.array(workCheckpointStepSchema).max(WORK_CHECKPOINT_MAX_STEPS);
const refIdsSchema = z.array(idSchema).max(WORK_CHECKPOINT_MAX_REFS);

/**
 * The structured part as it is stored (`WorkItemCheckpoint.state`). Every
 * member has a default, so a row written by an older version, or a system
 * checkpoint with nothing to carry, still reads as a whole state.
 */
export const workCheckpointStateSchema = z.object({
  plan: planSchema.default([]),
  assumptions: noteListSchema.default([]),
  findings: noteListSchema.default([]),
  lastAction: lineSchema.nullable().default(null),
  nextStep: lineSchema.nullable().default(null),
});
export type WorkCheckpointState = z.infer<typeof workCheckpointStateSchema>;

export const WORK_CHECKPOINT_REF_ROLES = ['artifact', 'source'] as const;
export const workCheckpointRefRoleSchema = z.enum(WORK_CHECKPOINT_REF_ROLES);
export type WorkCheckpointRefRole = z.infer<typeof workCheckpointRefRoleSchema>;

/** A page as it is stored on the row: the revision it had when recorded. */
export const storedWorkCheckpointRefSchema = z.object({
  documentId: idSchema,
  role: workCheckpointRefRoleSchema,
  /** `DocumentContent.yjsUpdatedAt` then; null for a page that had no content yet. */
  revision: isoDateTimeSchema.nullable(),
});
export type StoredWorkCheckpointRef = z.infer<typeof storedWorkCheckpointRefSchema>;

/** The same page as a reader sees it now. */
export const workCheckpointRefSchema = storedWorkCheckpointRefSchema.extend({
  /** Null when the page is gone, or in a workspace the reader cannot see. */
  title: z.string().nullable(),
  /** True when the page's content moved on since the checkpoint was recorded. */
  changedSince: z.boolean(),
});
export type WorkCheckpointRef = z.infer<typeof workCheckpointRefSchema>;

/** A human decision the work waited on when the checkpoint was recorded. */
export const workCheckpointDecisionSchema = z.object({
  attentionItemId: idSchema,
  title: z.string(),
  kind: attentionKindSchema,
  /** As it stands now, so a reader sees at once whether it was answered since. */
  status: attentionStatusSchema,
});
export type WorkCheckpointDecision = z.infer<typeof workCheckpointDecisionSchema>;

export const workCheckpointSchema = z.object({
  id: idSchema,
  workItemId: idSchema,
  runId: idSchema.nullable(),
  trigger: workCheckpointTriggerSchema,
  author: workItemParticipantSchema,
  agentLabel: z.string().nullable(),
  /** True when eXocortex recorded it at an interruption, carrying the last state forward. */
  system: z.boolean(),
  summary: z.string(),
  plan: z.array(workCheckpointStepSchema),
  assumptions: z.array(z.string()),
  findings: z.array(z.string()),
  lastAction: z.string().nullable(),
  nextStep: z.string().nullable(),
  refs: z.array(workCheckpointRefSchema),
  pendingDecisions: z.array(workCheckpointDecisionSchema),
  /** For `run_interrupted`: the error code the run ended with. */
  interruptionCode: z.string().nullable(),
  spentMicroUsd: z.number().int(),
  budgetMicroUsd: z.number().int().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type WorkCheckpoint = z.infer<typeof workCheckpointSchema>;

/**
 * Recording where the work stands.
 *
 * Only `summary` is needed, and only the first time: every field left out is
 * carried forward from the previous checkpoint, so a run that finished one
 * step sends the plan and nothing else. An empty list clears a list, `null`
 * clears a line. The page lists replace; each page is recorded at the
 * revision it has now, a carried page keeps the revision it was recorded at.
 */
export const recordWorkCheckpointRequestSchema = z.object({
  trigger: z.enum(RECORDABLE_CHECKPOINT_TRIGGERS).default('step'),
  summary: z.string().trim().min(1).max(WORK_CHECKPOINT_SUMMARY_MAX_CHARS).optional(),
  plan: planSchema.optional(),
  assumptions: noteListSchema.optional(),
  findings: noteListSchema.optional(),
  lastAction: lineSchema.nullable().optional(),
  nextStep: lineSchema.nullable().optional(),
  artifactDocumentIds: refIdsSchema.optional(),
  sourceDocumentIds: refIdsSchema.optional(),
});
export type RecordWorkCheckpointRequest = z.infer<typeof recordWorkCheckpointRequestSchema>;

export const workCheckpointResponseSchema = z.object({ checkpoint: workCheckpointSchema });
export type WorkCheckpointResponse = z.infer<typeof workCheckpointResponseSchema>;

export const listWorkCheckpointsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListWorkCheckpointsQuery = z.infer<typeof listWorkCheckpointsQuerySchema>;

/** Newest first; the first one is where the work stands. */
export const workCheckpointListResponseSchema = z.object({
  checkpoints: z.array(workCheckpointSchema),
  total: z.number().int(),
});
export type WorkCheckpointListResponse = z.infer<typeof workCheckpointListResponseSchema>;
