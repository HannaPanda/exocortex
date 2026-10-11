import {
  formatWorkflowOrigin,
  startWorkItemRunResponseSchema,
  WORKFLOW_ORIGIN_HEADER,
  type WorkflowNodeOf,
  workflowRunLimitsSchema,
  workItemResponseSchema,
} from '@exocortex/contracts';
import {
  lockWorkflowRun,
  type Prisma,
  type PrismaClient,
  workItemSubtreeSpend,
} from '@exocortex/database';
import { type ExocortexApiClient, ExocortexApiError } from '@exocortex/mcp-tools';

import { agentCompletion, agentResult, loadAgentWork } from './agent-completion';
import { renderGoalTemplate } from './goal-template';
import { type NodeContext, type NodeHandler, type NodeOutcome } from './handlers';

/**
 * The agent node (issue #162, ADR-077): hands its goal to an ordinary work
 * item, starts the built-in AI on it, and waits for the item -- not the run
 * -- to come back.
 *
 * Nothing here is a second way to run an agent. The item is created and the
 * run started through the REST API, as the person the workflow run acts for,
 * so every rule a work item has holds unchanged: the profile and its
 * snapshot, the write mode (the stricter of the node's, the profile's and the
 * workspace's), the tool domains, the workspace confinement, proposals and
 * review, checkpoints, delegation and the subtree budget. The origin header
 * adds two things the API checks against the rows: the item belongs to this
 * attempt, so a retried delivery gets the same item back, and the profile is
 * the one the published version names.
 */

export interface AgentNodeDependencies {
  prisma: PrismaClient;
  apiClientFor:
    ((userId: string, headers?: Readonly<Record<string, string>>) => ExocortexApiClient) | null;
  now?: () => Date;
}

/** A title is a title, not the goal. */
const MAX_TITLE_CHARS = 300;

export function createAgentNodeHandler(dependencies: AgentNodeDependencies): NodeHandler {
  return {
    // Every side effect is keyed by the attempt: the item by its
    // `workflowExecutionId`, the run by "the item has none yet".
    idempotent: true,
    // Two API calls, one of which queues a run; more than a step in memory.
    leaseMs: 120_000,
    execute: (context) => startWork(dependencies, context),
    resume: async (context) => settle(dependencies, context),
  };
}

async function startWork(
  dependencies: AgentNodeDependencies,
  context: NodeContext,
): Promise<NodeOutcome> {
  const node = context.node as WorkflowNodeOf<'agent'>;
  const { run } = context;
  if (dependencies.apiClientFor === null) {
    return refused('Workflows cannot start work: SERVICE_TOKEN_SECRET is not configured');
  }
  if (run.startedById === null) return refused('The run has nobody to act as');

  const budget = await reserveBudget(dependencies.prisma, context, node);
  if (budget === null) {
    return {
      status: 'failed',
      errorClass: 'limit_exceeded',
      code: 'workflow_budget_exhausted',
      message: 'The run has no budget left for this agent node',
    };
  }

  const client = dependencies.apiClientFor(run.startedById, {
    [WORKFLOW_ORIGIN_HEADER]: formatWorkflowOrigin({
      workflowId: run.workflowId,
      runId: run.id,
      executionId: context.execution.id,
      depth: run.chainDepth,
    }),
  });

  try {
    const created = await client.request({
      method: 'POST',
      path: `/api/workspaces/${run.workspaceId}/work-items`,
      body: {
        title: await titleFor(dependencies.prisma, run.workflowId, node),
        goal: renderGoalTemplate(node.goal, { input: run.input, outputs: context.outputs }),
        assignee: { kind: 'assistant' },
        contextDocumentIds: await contextFor(dependencies.prisma, run, node),
        budgetMicroUsd: budget,
        resultFields: node.outputFields,
        ...(node.writeMode === null ? {} : { writeMode: node.writeMode }),
        ...(node.agentProfileId === null ? {} : { agentProfileId: node.agentProfileId }),
      },
      responseSchema: workItemResponseSchema,
    });
    const item = created.workItem;
    // A delivery after the first got the item back with its run already
    // started; starting another would be a second attempt nobody asked for.
    let aiRunId = item.runs[0]?.id ?? null;
    if (item.runs.length === 0) {
      const started = await client.request({
        method: 'POST',
        path: `/api/work-items/${item.id}/runs`,
        body: {},
        responseSchema: startWorkItemRunResponseSchema,
      });
      aiRunId = started.run.id;
    }
    return {
      status: 'waiting',
      wait: { kind: 'work_item', workItemId: item.id },
      workItemId: item.id,
      aiRunId,
    };
  } catch (error) {
    // A refusal is an answer: the AI is off, the profile is not usable, the
    // budget is spent. A server error or a dropped connection is thrown on,
    // and the runtime retries the attempt, which finds what it already made.
    if (error instanceof ExocortexApiError && error.status < 500) {
      return refused(`The API refused the work (${error.code}): ${error.message}`);
    }
    throw error;
  }
}

/** Woken by the item, or by the sweep: decide from the item as it is now. */
async function settle(
  dependencies: AgentNodeDependencies,
  context: NodeContext,
): Promise<NodeOutcome> {
  const node = context.node as WorkflowNodeOf<'agent'>;
  const workItemId = await waitedOn(dependencies.prisma, context.execution.id);
  const work = workItemId === null ? null : await loadAgentWork(dependencies.prisma, workItemId);
  const decision = agentCompletion(node, work, dependencies.now?.() ?? new Date());
  if (decision.kind === 'wait' && work !== null) {
    return {
      status: 'waiting',
      wait: { kind: 'work_item', workItemId: work.id },
      workItemId: work.id,
    };
  }
  const spentMicroUsd =
    work === null ? 0 : await workItemSubtreeSpend(dependencies.prisma, work.id);
  if (decision.kind === 'complete' && work !== null) {
    return {
      status: 'succeeded',
      handles: ['next'],
      output: agentResult({
        work,
        outcome: decision.outcome,
        fields: decision.fields,
        spentMicroUsd,
      }),
      workItemId: work.id,
      aiRunId: work.runs[0]?.id ?? null,
      spentMicroUsd,
    };
  }
  return {
    status: 'failed',
    errorClass: 'terminal',
    code: decision.kind === 'fail' ? decision.code : 'workflow_work_item_gone',
    message: decision.kind === 'fail' ? decision.message : 'The work item is gone',
    spentMicroUsd,
  };
}

function refused(message: string): NodeOutcome {
  return { status: 'failed', errorClass: 'terminal', code: 'workflow_agent_refused', message };
}

/** The item the attempt waits on, from its own row, never from the job. */
async function waitedOn(prisma: PrismaClient, executionId: string): Promise<string | null> {
  const row = await prisma.workflowNodeExecution.findUnique({
    where: { id: executionId },
    select: { waitingOn: true },
  });
  const wait = row?.waitingOn;
  if (typeof wait !== 'object' || wait === null || Array.isArray(wait)) return null;
  const id = (wait as Record<string, unknown>).workItemId;
  return typeof id === 'string' ? id : null;
}

/**
 * The part of the run's budget this node may spend, reserved under the
 * run's lock so two agent nodes on parallel branches cannot both be handed
 * the same remainder. What the node's work actually costs replaces the
 * reservation when the node finishes (`spentMicroUsd` on its outcome). A
 * delivery after the first finds its reservation on the attempt and keeps it.
 */
async function reserveBudget(
  prisma: PrismaClient,
  context: NodeContext,
  node: WorkflowNodeOf<'agent'>,
): Promise<number | null> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockWorkflowRun(tx, context.run.id, new Date()))) return null;
    const self = await tx.workflowNodeExecution.findUniqueOrThrow({
      where: { id: context.execution.id },
      select: { input: true },
    });
    const kept = reservationOf(self.input);
    if (kept !== null) return kept;

    const run = await tx.workflowRun.findUniqueOrThrow({
      where: { id: context.run.id },
      select: { spentMicroUsd: true, limits: true },
    });
    const limits = workflowRunLimitsSchema.safeParse(run.limits);
    if (!limits.success) return null;
    const others = await tx.workflowNodeExecution.findMany({
      where: {
        runId: context.run.id,
        nodeType: 'agent',
        status: { in: ['RUNNING', 'WAITING'] },
        id: { not: context.execution.id },
      },
      select: { input: true },
    });
    const reserved = others.reduce((sum, row) => sum + (reservationOf(row.input) ?? 0), 0);
    const remaining = limits.data.budgetMicroUsd - run.spentMicroUsd - reserved;
    if (remaining <= 0) return null;
    const budget = Math.min(node.budgetMicroUsd ?? remaining, remaining);
    await tx.workflowNodeExecution.update({
      where: { id: context.execution.id },
      data: { input: { reservedMicroUsd: budget } satisfies Prisma.InputJsonObject },
    });
    return budget;
  });
}

function reservationOf(input: Prisma.JsonValue): number | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>).reservedMicroUsd;
  return typeof value === 'number' ? value : null;
}

async function titleFor(
  prisma: PrismaClient,
  workflowId: string,
  node: WorkflowNodeOf<'agent'>,
): Promise<string> {
  const workflow = await prisma.workflow.findUnique({
    where: { id: workflowId },
    select: { name: true },
  });
  const step = node.label ?? node.id;
  return `${workflow?.name ?? 'Workflow'}: ${step}`.slice(0, MAX_TITLE_CHARS);
}

/**
 * The node's pages, and for a run a page change started, that page first:
 * a workflow reacting to an edit is about the edited page. Only a page that
 * still exists in the run's workspace, so one deleted since the graph was
 * written does not make the API refuse the whole item.
 */
async function contextFor(
  prisma: PrismaClient,
  run: NodeContext['run'],
  node: WorkflowNodeOf<'agent'>,
): Promise<string[]> {
  const trigger =
    typeof run.input === 'object' && run.input !== null && !Array.isArray(run.input)
      ? (run.input as Record<string, unknown>).documentId
      : undefined;
  const ids = [
    ...new Set([...(typeof trigger === 'string' ? [trigger] : []), ...node.documentIds]),
  ];
  if (ids.length === 0) return [];
  const alive = await prisma.document.findMany({
    where: { id: { in: ids }, workspaceId: run.workspaceId },
    select: { id: true },
  });
  const found = new Set(alive.map((row) => row.id));
  return ids.filter((id) => found.has(id));
}
