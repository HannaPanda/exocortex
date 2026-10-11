import { z } from 'zod';

import { aiWriteModeSchema } from './ai-trust';
import { idSchema, isoDateTimeSchema } from './primitives';
import { workItemParticipantKindSchema } from './work-items';
import { WORKFLOW_LIMITS, WORKFLOW_TRIGGER_TYPES, workflowGraphSchema } from './workflow-graph';
import { workflowNodeExecutionStatusSchema } from './workflow-progress';
import { workflowRunEventTypeSchema, workflowRunLimitsSchema } from './workflow-runtime';
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
 * different decision from what its graph says. An agent may write and
 * revise a draft (issue #165, ADR-080); publishing and switching on are a
 * person's, at the browser, and the draft says who wrote it.
 */

const accountSchema = z.object({ id: idSchema, name: z.string().nullable() });

/**
 * Who wrote a graph (issue #165): the account and how the request arrived.
 * `agent` is an external client that named an agent session (Hermes, Claude
 * Code), `assistant` a run of the built-in AI, `human` everything else.
 * Provenance shown to the person who reviews it, never a permission.
 */
export const workflowAuthorSchema = z.object({
  kind: workItemParticipantKindSchema,
  account: accountSchema.nullable(),
  /** The agent client's own name for itself, unverified. */
  agentLabel: z.string().nullable(),
  /** The run of the built-in AI that wrote it. */
  aiRunId: idSchema.nullable(),
});
export type WorkflowAuthor = z.infer<typeof workflowAuthorSchema>;

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
  /** Who wrote the draft's current graph, and when. */
  draftAuthor: workflowAuthorSchema.extend({ at: isoDateTimeSchema }),
  createdBy: accountSchema.nullable(),
  updatedBy: accountSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

export const workflowListResponseSchema = z.object({ workflows: z.array(workflowSummarySchema) });
export type WorkflowListResponse = z.infer<typeof workflowListResponseSchema>;

/**
 * What the workspace allows a run of this workflow (issue #164): the frame
 * the graph's own settings are combined with by taking the stricter. The
 * editor shows these effective values beside the configured ones, so an
 * inherited restriction is never hidden; an agent reads the same.
 */
export const workflowEnvelopeSchema = z.object({
  /** `workflows.enabled`: while off, no run starts, not even by hand. */
  workflowsEnabled: z.boolean(),
  /** The workspace's `ai.writeMode`: no agent node writes more freely than this. */
  writeMode: aiWriteModeSchema,
  /** The draft's limits combined with the workspace's, as a run started now would freeze them. */
  limits: workflowRunLimitsSchema,
});
export type WorkflowEnvelope = z.infer<typeof workflowEnvelopeSchema>;

export const workflowResponseSchema = z.object({
  workflow: workflowSummarySchema,
  draft: workflowGraphSchema,
  /** What stands between the draft and publishing; empty when it is valid. */
  problems: z.array(workflowProblemSchema),
  envelope: workflowEnvelopeSchema,
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
  /**
   * The draft revision the person reviewed; refused when it has moved on
   * since. Required (issue #165): an agent may be revising the draft while
   * somebody reads it, and what becomes a version is exactly what was read.
   */
  expectedRevision: z.number().int().min(1),
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

/**
 * Copies a workflow's draft into a new workflow (issue #165). The copy is a
 * draft and nothing more: no versions, no runs, switched off.
 */
export const duplicateWorkflowRequestSchema = z.object({
  /** The new workflow's name; "<name> (Kopie)" and a number when left out. */
  name: nameSchema.optional(),
});
export type DuplicateWorkflowRequest = z.infer<typeof duplicateWorkflowRequestSchema>;

export const workflowVersionSchema = z.object({
  id: idSchema,
  workflowId: idSchema,
  version: z.number().int(),
  graph: workflowGraphSchema,
  /** sha256 of the canonical graph JSON; equal hashes are equal graphs. */
  graphHash: z.string(),
  /** The draft revision that was published. */
  draftRevision: z.number().int(),
  /** Who wrote the graph that was published. */
  draftAuthor: workflowAuthorSchema,
  /** Always a person: publishing is never an agent's (issue #165). */
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
  /** The limits the run executes under, frozen when it started (issue #161). */
  limits: workflowRunLimitsSchema.nullable(),
  /** When it times out. */
  deadlineAt: isoDateTimeSchema.nullable(),
  /** How many automations or workflows deep the change that started it was. */
  chainDepth: z.number().int(),
  /**
   * A ceiling on every agent node's write mode (issue #164); a test run
   * proposes unless whoever started it chose otherwise. Null: no opinion.
   */
  writeMode: aiWriteModeSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** What the end node the run ended at says about it (issue #163). */
  summary: z.string().nullable(),
  /** The end node the run ended at; null for a run that ended anywhere else. */
  endNodeId: z.string().nullable(),
  waitingSince: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

/**
 * One fact of a run's history (issue #161): what happened, to which node and
 * attempt, when. `detail` carries ids, handles, durations and error classes,
 * never content.
 */
export const workflowRunEventSchema = z.object({
  sequence: z.number().int(),
  type: workflowRunEventTypeSchema,
  nodeId: z.string().nullable(),
  executionId: idSchema.nullable(),
  attempt: z.number().int().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  at: isoDateTimeSchema,
});
export type WorkflowRunEvent = z.infer<typeof workflowRunEventSchema>;

export const workflowRunListResponseSchema = z.object({ runs: z.array(workflowRunSchema) });
export type WorkflowRunListResponse = z.infer<typeof workflowRunListResponseSchema>;

export const workflowRunResponseSchema = z.object({
  run: workflowRunSchema,
  /** The graph of the version the run started on, never the current draft. */
  graph: workflowGraphSchema,
  nodeExecutions: z.array(workflowNodeExecutionSchema),
  /** The history in order, enough to replay the path the run took. */
  events: z.array(workflowRunEventSchema),
  /** `workflowProgress` over the rows above. */
  progress: z.object({
    runnable: z.array(z.string()),
    dead: z.array(z.string()),
    active: z.array(z.string()),
    settled: z.boolean(),
  }),
});
export type WorkflowRunResponse = z.infer<typeof workflowRunResponseSchema>;

/**
 * Starting a run by hand (issue #161). Without `triggerNodeId` the run starts
 * from the published version's only manual trigger; `input` is handed to the
 * run as what its trigger supplied.
 *
 * `test` (issue #164) is a deliberate trial from the editor: it may start
 * from any trigger, schedule and event ones included, and its agent nodes
 * propose rather than write unless `writeMode` says otherwise. `writeMode`
 * only ever narrows: every agent node is held to the stricter of it and its
 * own, and the work item adds the profile's and the workspace's on top.
 */
export const startWorkflowRunRequestSchema = z.object({
  triggerNodeId: z.string().min(1).max(64).optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  test: z.boolean().optional(),
  writeMode: aiWriteModeSchema.optional(),
});
export type StartWorkflowRunRequest = z.infer<typeof startWorkflowRunRequestSchema>;

export const workflowRunStartResponseSchema = z.object({ run: workflowRunSchema });
export type WorkflowRunStartResponse = z.infer<typeof workflowRunStartResponseSchema>;

/** Cancelling a run: what is queued or waiting stops, a running step finishes unrecorded. */
export const cancelWorkflowRunRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type CancelWorkflowRunRequest = z.infer<typeof cancelWorkflowRunRequestSchema>;
