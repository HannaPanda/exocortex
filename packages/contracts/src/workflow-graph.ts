import { z } from 'zod';

import { aiWriteModeSchema } from './ai-trust';
import {
  automationCronSchema,
  automationScheduleTimeSchema,
  automationTimeZoneSchema,
} from './automation-schedule';
import { automationTriggerSchema } from './automations';
import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * The graph of an agent workflow (issue #160, ADR-075).
 *
 * A workflow is a directed graph of typed nodes joined by typed edges. This
 * file is its shape and nothing else: which node types exist, what each one
 * is configured with, which handles it offers. Whether a graph makes sense --
 * an edge into a node that exists, a join that can ever complete, no cycle --
 * is `validateWorkflowGraph` in `workflow-validation.ts`, and how far a run
 * has come is `workflowProgress` in `workflow-progress.ts`.
 *
 * Two layers on purpose. The schema here is the contract boundary: a node of
 * an unknown type, a handle with a wrong name or a field of the wrong type is
 * refused before anything is stored, even in a draft. Whether a required text
 * is filled in is a semantic problem, so a draft somebody is still writing
 * can be saved half-done and only publishing asks for it to be whole.
 *
 * The graph is stored as one JSON document per version, because a published
 * version is immutable and is only ever read whole; everything a query has to
 * answer about it (which workflow, which version, when, by whom, enabled) is
 * a column beside it.
 */

export const WORKFLOW_GRAPH_SCHEMA_VERSION = 1;

export const WORKFLOW_LIMITS = {
  nameMaxChars: 80,
  descriptionMaxChars: 500,
  maxNodes: 100,
  maxEdges: 200,
  labelMaxChars: 80,
  goalMaxChars: 8_000,
  questionMaxChars: 2_000,
  summaryMaxChars: 2_000,
  maxContextDocuments: 10,
  maxOutputFields: 20,
  maxEnumValues: 20,
  maxEventTypes: 7,
  /** Ceilings for a graph's own limits; a graph may only set something lower. */
  maxNodeExecutions: 1_000,
  maxParallelBranches: 20,
  maxLifetimeSeconds: 30 * 24 * 3_600,
} as const;

/** A node's id inside its graph: stable across versions, chosen by the editor. */
export const workflowNodeIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u, 'Letters, digits, "_" and "-", starting with a letter');
export const workflowEdgeIdSchema = workflowNodeIdSchema;

/** A field name in a node's structured output, addressable from a condition. */
export const workflowFieldNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/u, 'Letters, digits and "_", starting with a letter');

const labelSchema = z.string().trim().max(WORKFLOW_LIMITS.labelMaxChars);
const microUsdSchema = z.number().int().min(0).max(1_000_000_000);

/** Where the editor drew a node. Has no meaning for execution. */
const positionSchema = z.object({
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
});

const nodeBase = {
  id: workflowNodeIdSchema,
  label: labelSchema.nullable().optional(),
  position: positionSchema.nullable().optional(),
};

// -- triggers -----------------------------------------------------------------

/**
 * When a scheduled workflow starts. The same five shapes and the same zone
 * rule as a scheduled automation (ADR-038), so `nextAutomationRun` computes
 * both, but as a closed union: a weekly schedule cannot carry a cron.
 */
export const workflowScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ONCE'), at: isoDateTimeSchema, timeZone: automationTimeZoneSchema }),
  z.object({
    kind: z.literal('DAILY'),
    time: automationScheduleTimeSchema,
    timeZone: automationTimeZoneSchema,
  }),
  z.object({
    kind: z.literal('WEEKLY'),
    time: automationScheduleTimeSchema,
    weekday: z.number().int().min(0).max(6),
    timeZone: automationTimeZoneSchema,
  }),
  z.object({
    kind: z.literal('MONTHLY'),
    time: automationScheduleTimeSchema,
    dayOfMonth: z.number().int().min(1).max(31),
    timeZone: automationTimeZoneSchema,
  }),
  z.object({
    kind: z.literal('CRON'),
    cron: automationCronSchema,
    timeZone: automationTimeZoneSchema,
  }),
]);
export type WorkflowSchedule = z.infer<typeof workflowScheduleSchema>;

/** A change that can start a workflow: every automation trigger but the clock. */
export const workflowEventTypeSchema = automationTriggerSchema.exclude(['SCHEDULE']);
export type WorkflowEventType = z.infer<typeof workflowEventTypeSchema>;

const manualTriggerSchema = z.object({ ...nodeBase, type: z.literal('trigger.manual') });

const scheduleTriggerSchema = z.object({
  ...nodeBase,
  type: z.literal('trigger.schedule'),
  schedule: workflowScheduleSchema,
});

const eventTriggerSchema = z.object({
  ...nodeBase,
  type: z.literal('trigger.event'),
  events: z.array(workflowEventTypeSchema).max(WORKFLOW_LIMITS.maxEventTypes),
  /** The subtree the change has to happen in; null means the whole workspace. */
  scopeDocumentId: idSchema.nullable(),
});

// -- work -----------------------------------------------------------------------

export const WORKFLOW_OUTPUT_FIELD_TYPES = ['string', 'number', 'boolean', 'enum'] as const;
export const workflowOutputFieldTypeSchema = z.enum(WORKFLOW_OUTPUT_FIELD_TYPES);
export type WorkflowOutputFieldType = z.infer<typeof workflowOutputFieldTypeSchema>;

/**
 * One field of the structured result an agent node promises. Downstream
 * conditions branch on these, never on prose (issue #162).
 */
export const workflowOutputFieldSchema = z.object({
  name: workflowFieldNameSchema,
  type: workflowOutputFieldTypeSchema,
  /** `enum`: the allowed values. Empty for every other type. */
  values: z.array(z.string().trim().min(1).max(80)).max(WORKFLOW_LIMITS.maxEnumValues).default([]),
  required: z.boolean().default(true),
  description: z.string().trim().max(300).nullable().optional(),
});
export type WorkflowOutputField = z.infer<typeof workflowOutputFieldSchema>;

/**
 * When an agent node counts as complete (issue #162).
 *
 * `review`: once the work is handed in (`review`) or closed as `done`, unless
 * a person still has to decide about it: a proposal waiting to be applied,
 * or a profile that wants a review before done. `done`: only once it is
 * `done`, which for work the built-in AI hands in means a person accepted it.
 * `failed` and `cancelled` fail the node either way.
 */
export const WORKFLOW_AGENT_COMPLETIONS = ['review', 'done'] as const;
export const workflowAgentCompletionSchema = z.enum(WORKFLOW_AGENT_COMPLETIONS);
export type WorkflowAgentCompletion = z.infer<typeof workflowAgentCompletionSchema>;

const agentNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('agent'),
  /** What the work item is asked to achieve. Required to publish, not to save. */
  goal: z.string().max(WORKFLOW_LIMITS.goalMaxChars),
  /** Pages the work item carries as context. */
  documentIds: z.array(idSchema).max(WORKFLOW_LIMITS.maxContextDocuments).default([]),
  /** Null: the workspace's default profile, as for any work item (ADR-071). */
  agentProfileId: idSchema.nullable().default(null),
  /** Null: no opinion. Only ever combined by taking the stricter (ADR-070). */
  writeMode: aiWriteModeSchema.nullable().default(null),
  budgetMicroUsd: microUsdSchema.nullable().default(null),
  outputFields: z.array(workflowOutputFieldSchema).max(WORKFLOW_LIMITS.maxOutputFields).default([]),
  /**
   * Added by #162 with a default, so every graph stored before still parses
   * to the behaviour it would have had: continue once the work is handed in.
   */
  completion: workflowAgentCompletionSchema.default('review'),
});

// -- control --------------------------------------------------------------------

export const WORKFLOW_CONDITION_OPERATORS = [
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'present',
  'absent',
  'is_true',
  'is_false',
] as const;
export const workflowConditionOperatorSchema = z.enum(WORKFLOW_CONDITION_OPERATORS);
export type WorkflowConditionOperator = z.infer<typeof workflowConditionOperatorSchema>;

const conditionNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('condition'),
  /** A field of an upstream agent node's structured output. */
  source: z.object({ nodeId: workflowNodeIdSchema, field: workflowFieldNameSchema }),
  operator: workflowConditionOperatorSchema,
  /** Compared against; absent for the operators that take none. */
  value: z
    .union([z.string().max(200), z.number().finite(), z.boolean()])
    .nullable()
    .default(null),
});

const parallelNodeSchema = z.object({ ...nodeBase, type: z.literal('parallel') });

export const WORKFLOW_JOIN_POLICIES = ['all', 'any'] as const;
export const workflowJoinPolicySchema = z.enum(WORKFLOW_JOIN_POLICIES);
export type WorkflowJoinPolicy = z.infer<typeof workflowJoinPolicySchema>;

const joinNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('join'),
  policy: workflowJoinPolicySchema,
});

const approvalNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('approval'),
  title: z.string().trim().max(WORKFLOW_LIMITS.labelMaxChars),
  question: z.string().trim().max(WORKFLOW_LIMITS.questionMaxChars),
  /** Null: anybody who may answer in the workspace (ADR-067). */
  assigneeUserId: idSchema.nullable().default(null),
});

export const WORKFLOW_END_OUTCOMES = ['succeeded', 'failed', 'cancelled'] as const;
export const workflowEndOutcomeSchema = z.enum(WORKFLOW_END_OUTCOMES);
export type WorkflowEndOutcome = z.infer<typeof workflowEndOutcomeSchema>;

const endNodeSchema = z.object({
  ...nodeBase,
  type: z.literal('end'),
  outcome: workflowEndOutcomeSchema,
  summary: z.string().trim().max(WORKFLOW_LIMITS.summaryMaxChars).nullable().default(null),
});

/** Every node type there is. Closed: a type nothing executes cannot be stored. */
export const workflowNodeSchema = z.discriminatedUnion('type', [
  manualTriggerSchema,
  scheduleTriggerSchema,
  eventTriggerSchema,
  agentNodeSchema,
  conditionNodeSchema,
  parallelNodeSchema,
  joinNodeSchema,
  approvalNodeSchema,
  endNodeSchema,
]);
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowNodeType = WorkflowNode['type'];
export type WorkflowNodeOf<T extends WorkflowNodeType> = Extract<WorkflowNode, { type: T }>;

export const WORKFLOW_NODE_TYPES = [
  'trigger.manual',
  'trigger.schedule',
  'trigger.event',
  'agent',
  'condition',
  'parallel',
  'join',
  'approval',
  'end',
] as const satisfies readonly WorkflowNodeType[];

export const WORKFLOW_TRIGGER_TYPES = [
  'trigger.manual',
  'trigger.schedule',
  'trigger.event',
] as const satisfies readonly WorkflowNodeType[];
export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];

export function isTriggerNode(
  node: WorkflowNode,
): node is WorkflowNodeOf<'trigger.manual' | 'trigger.schedule' | 'trigger.event'> {
  return (WORKFLOW_TRIGGER_TYPES as readonly string[]).includes(node.type);
}

/**
 * The handles each node type offers outwards, in the order the editor draws
 * them. A node is entered through its one implicit input; an edge names a
 * source handle and a target node.
 */
export const WORKFLOW_NODE_HANDLES: Readonly<Record<WorkflowNodeType, readonly string[]>> = {
  'trigger.manual': ['next'],
  'trigger.schedule': ['next'],
  'trigger.event': ['next'],
  agent: ['next'],
  condition: ['true', 'false'],
  parallel: ['branch'],
  join: ['next'],
  approval: ['approved', 'rejected'],
  end: [],
};

/** Handles that may carry more than one edge: the branches of a fan-out. */
export const WORKFLOW_FAN_OUT_HANDLES: Readonly<Partial<Record<WorkflowNodeType, string>>> = {
  parallel: 'branch',
};

/**
 * Node types whose handles exclude each other: exactly one of them fires.
 * Two inputs of a waiting-for-all join that came out of different handles of
 * one of these can never both arrive.
 */
export const WORKFLOW_EXCLUSIVE_NODE_TYPES: readonly WorkflowNodeType[] = ['condition', 'approval'];

/** Edges are typed too, so a later kind (a loop, an error path) is a new member. */
export const workflowEdgeSchema = z.discriminatedUnion('kind', [
  z.object({
    id: workflowEdgeIdSchema,
    kind: z.literal('flow'),
    source: z.object({ nodeId: workflowNodeIdSchema, handle: z.string().min(1).max(32) }),
    target: z.object({ nodeId: workflowNodeIdSchema }),
  }),
]);
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

/**
 * A graph's own ceilings. Each is combined with the deployment's, the
 * workspace's, the profile's and the work item's by taking the stricter
 * (`stricterLimit`), so a graph can only ever narrow (issue #161).
 */
export const workflowGraphLimitsSchema = z.object({
  maxNodeExecutions: z
    .number()
    .int()
    .min(1)
    .max(WORKFLOW_LIMITS.maxNodeExecutions)
    .nullable()
    .default(null),
  maxParallelBranches: z
    .number()
    .int()
    .min(1)
    .max(WORKFLOW_LIMITS.maxParallelBranches)
    .nullable()
    .default(null),
  maxLifetimeSeconds: z
    .number()
    .int()
    .min(60)
    .max(WORKFLOW_LIMITS.maxLifetimeSeconds)
    .nullable()
    .default(null),
  budgetMicroUsd: microUsdSchema.nullable().default(null),
});
export type WorkflowGraphLimits = z.infer<typeof workflowGraphLimitsSchema>;

export const workflowGraphSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_GRAPH_SCHEMA_VERSION),
  nodes: z.array(workflowNodeSchema).max(WORKFLOW_LIMITS.maxNodes),
  edges: z.array(workflowEdgeSchema).max(WORKFLOW_LIMITS.maxEdges),
  limits: workflowGraphLimitsSchema.default({
    maxNodeExecutions: null,
    maxParallelBranches: null,
    maxLifetimeSeconds: null,
    budgetMicroUsd: null,
  }),
});
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;
/** What a caller sends: defaults may be left out. */
export type WorkflowGraphInput = z.input<typeof workflowGraphSchema>;

/** The graph a new workflow starts with: one manual trigger and nothing else. */
export function emptyWorkflowGraph(): WorkflowGraph {
  return {
    schemaVersion: WORKFLOW_GRAPH_SCHEMA_VERSION,
    nodes: [{ id: 'start', type: 'trigger.manual', label: null, position: { x: 0, y: 0 } }],
    edges: [],
    limits: {
      maxNodeExecutions: null,
      maxParallelBranches: null,
      maxLifetimeSeconds: null,
      budgetMicroUsd: null,
    },
  };
}
