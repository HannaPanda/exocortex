import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';
import { WORKFLOW_LIMITS, workflowGraphSchema, WORKFLOW_TRIGGER_TYPES } from './workflow-graph';
import { workflowNodeExecutionStatusSchema } from './workflow-progress';
import { workflowProblemSchema } from './workflow-validation';

/**
 * Agent workflows over the API (issue #160, ADR-075).
 *
 * A workflow has one mutable draft and a list of immutable published
 * versions. Saving changes the draft and moves `draftRevision`; publishing
 * validates the draft and freezes it as the next version; a run names the
 * version it started on and reads that graph and no other, so editing or
 * publishing never changes what a run in flight is executing.
 *
 * Enabling is its own call: whether a workflow may start by itself is a
 * different decision from what its graph says, and a separate one an agent
 * will not be offered (issue #165).
 */

const accountSchema = z.object({ id: idSchema, name: z.string().nullable() });

const nameSchema = z.string().trim().min(1).max(WORKFLOW_LIMITS.nameMaxChars);
const descriptionSchema = z.string().trim().max(WORKFLOW_LIMITS.descriptionMaxChars);

export const workflowTriggerTypeSchema = z.enum(WORKFLOW_TRIGGER_TYPES);

export const workflowVersionRefSchema = z.object({
  id: idSchema,
  version: z.number().int(),
  publishedAt: isoDateTimeSchema,
});
export type WorkflowVersionRef = z.infer<typeof workflowVersionRefSchema>;

export const workflowSummarySchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string(),
  description: z.string().nullable(),
  /** May start by itself (schedule, event). Only a published workflow can be. */
  enabled: z.boolean(),
  /** Moves on every save of the draft; an update may name it to refuse a lost edit. */
  draftRevision: z.number().int(),
  /** The draft would publish as it is. */
  draftValid: z.boolean(),
  /** The draft differs from the newest published version. */
  hasUnpublishedChanges: z.boolean(),
  publishedVersion: workflowVersionRefSchema.nullable(),
  /** The triggers of the published version, or of the draft before the first. */
  triggerTypes: z.array(workflowTriggerTypeSchema),
  /** Runs that have not reached a terminal status. */
  activeRunCount: z.number().int(),
  createdBy: accountSchema.nullable(),
  updatedBy: accountSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

export const workflowListResponseSchema = z.object({ workflows: z.array(workflowSummarySchema) });
export type WorkflowListResponse = z.infer<typeof workflowListResponseSchema>;

export const workflowResponseSchema = z.object({
  workflow: workflowSummarySchema,
  draft: workflowGraphSchema,
  /** What stands between the draft and publishing; empty when it is valid. */
  problems: z.array(workflowProblemSchema),
});
export type WorkflowResponse = z.infer<typeof workflowResponseSchema>;

export const createWorkflowRequestSchema = z.object({
  name: nameSchema,
  description: descriptionSchema.nullable().optional(),
  /** One manual trigger when left out. May be incomplete: it is a draft. */
  graph: workflowGraphSchema.optional(),
});
export type CreateWorkflowRequest = z.input<typeof createWorkflowRequestSchema>;

export const updateWorkflowRequestSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    graph: workflowGraphSchema.optional(),
    /** Refused with `workflow_revision_conflict` when the draft has moved on. */
    expectedRevision: z.number().int().min(1).optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined || value.description !== undefined || value.graph !== undefined,
    { message: 'Nothing to update' },
  );
export type UpdateWorkflowRequest = z.input<typeof updateWorkflowRequestSchema>;

/**
 * Checks a graph without storing it. `graph` is deliberately untyped: the
 * point of this call is to answer about something that may not parse.
 */
export const validateWorkflowRequestSchema = z.object({ graph: z.unknown().optional() });
export type ValidateWorkflowRequest = z.infer<typeof validateWorkflowRequestSchema>;

export const workflowValidationResponseSchema = z.object({
  valid: z.boolean(),
  problems: z.array(workflowProblemSchema),
});
export type WorkflowValidationResponse = z.infer<typeof workflowValidationResponseSchema>;

export const publishWorkflowRequestSchema = z.object({
  /** The draft revision the person reviewed; refused when it has moved on since. */
  expectedRevision: z.number().int().min(1).optional(),
});
export type PublishWorkflowRequest = z.infer<typeof publishWorkflowRequestSchema>;

export const setWorkflowActivationRequestSchema = z.object({ enabled: z.boolean() });
export type SetWorkflowActivationRequest = z.infer<typeof setWorkflowActivationRequestSchema>;

export const deleteWorkflowResponseSchema = z.object({
  deleted: z.literal(true),
  /** Finished runs that went with it. */
  deletedRuns: z.number().int(),
});
export type DeleteWorkflowResponse = z.infer<typeof deleteWorkflowResponseSchema>;

export const workflowVersionSchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  version: z.number().int(),
  graph: workflowGraphSchema,
  /** sha256 of the canonical graph JSON; equal hashes are equal graphs. */
  graphHash: z.string(),
  /** The draft revision that was published. */
  draftRevision: z.number().int(),
  publishedBy: accountSchema.nullable(),
  publishedAt: isoDateTimeSchema,
});
export type WorkflowVersion = z.infer<typeof workflowVersionSchema>;

export const workflowVersionResponseSchema = z.object({ version: workflowVersionSchema });
export type WorkflowVersionResponse = z.infer<typeof workflowVersionResponseSchema>;

export const workflowVersionListResponseSchema = z.object({
  versions: z.array(workflowVersionSchema.omit({ graph: true })),
});
export type WorkflowVersionListResponse = z.infer<typeof workflowVersionListResponseSchema>;

export const publishWorkflowResponseSchema = z.object({
  workflow: workflowSummarySchema,
  version: workflowVersionSchema,
});
export type PublishWorkflowResponse = z.infer<typeof publishWorkflowResponseSchema>;

// -- runs -------------------------------------------------------------------------

/**
 * A run's overall status. `waiting` means a node waits for something durable
 * (a work item, a person) and no worker is held; the four after it are
 * terminal and a run never leaves them.
 */
export const WORKFLOW_RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export const workflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

export const WORKFLOW_RUN_TERMINAL_STATUSES: readonly WorkflowRunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
];

/** What started a run. `test` is a deliberate trial from the editor (issue #164). */
export const WORKFLOW_RUN_ORIGINS = ['manual', 'schedule', 'event', 'test'] as const;
export const workflowRunOriginSchema = z.enum(WORKFLOW_RUN_ORIGINS);
export type WorkflowRunOrigin = z.infer<typeof workflowRunOriginSchema>;

/**
 * Why a node failed, in classes a runtime can act on: only `retryable` is
 * tried again, and only up to the node's attempt limit (issue #161).
 */
export const WORKFLOW_ERROR_CLASSES = [
  'retryable',
  'terminal',
  'timeout',
  'cancelled',
  'limit_exceeded',
] as const;
export const workflowErrorClassSchema = z.enum(WORKFLOW_ERROR_CLASSES);
export type WorkflowErrorClass = z.infer<typeof workflowErrorClassSchema>;

/**
 * What a waiting node waits for. The object is durable and has its own
 * lifecycle; the node resumes from an event about it, never by a worker
 * sleeping on it.
 */
export const workflowWaitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('work_item'), workItemId: idSchema }),
  z.object({ kind: z.literal('attention_item'), attentionItemId: idSchema }),
  z.object({ kind: z.literal('timer'), until: isoDateTimeSchema }),
]);
export type WorkflowWait = z.infer<typeof workflowWaitSchema>;

export const workflowNodeExecutionSchema = z.object({
  id: idSchema,
  nodeId: z.string(),
  nodeType: z.string(),
  attempt: z.number().int(),
  status: workflowNodeExecutionStatusSchema,
  /** `<runId>:<nodeId>:<attempt>`: what a side effect is keyed by, so a retry cannot repeat it. */
  idempotencyKey: z.string(),
  firedHandles: z.array(z.string()),
  input: z.unknown().nullable(),
  output: z.unknown().nullable(),
  waitingOn: workflowWaitSchema.nullable(),
  errorClass: workflowErrorClassSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  workItemId: idSchema.nullable(),
  aiRunId: idSchema.nullable(),
  queuedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});
export type WorkflowNodeExecution = z.infer<typeof workflowNodeExecutionSchema>;

export const workflowRunSchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  workspaceId: idSchema,
  workflowVersionId: idSchema,
  version: z.number().int(),
  status: workflowRunStatusSchema,
  origin: workflowRunOriginSchema,
  triggerNodeId: z.string(),
  input: z.unknown().nullable(),
  correlationId: z.string().nullable(),
  startedBy: accountSchema.nullable(),
  /** Millionths of a dollar spent by every AI run the workflow caused. */
  spentMicroUsd: z.number().int(),
  nodeExecutionCount: z.number().int(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  waitingSince: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const workflowRunListResponseSchema = z.object({ runs: z.array(workflowRunSchema) });
export type WorkflowRunListResponse = z.infer<typeof workflowRunListResponseSchema>;

export const workflowRunResponseSchema = z.object({
  run: workflowRunSchema,
  /** The graph of the version the run started on, never the current draft. */
  graph: workflowGraphSchema,
  nodeExecutions: z.array(workflowNodeExecutionSchema),
  /** `workflowProgress` over the rows above. */
  progress: z.object({
    runnable: z.array(z.string()),
    dead: z.array(z.string()),
    active: z.array(z.string()),
    settled: z.boolean(),
  }),
});
export type WorkflowRunResponse = z.infer<typeof workflowRunResponseSchema>;
