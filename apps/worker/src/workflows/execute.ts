import { randomUUID } from 'node:crypto';

import { type WorkflowGraph, type WorkflowWait, workflowWaitSchema } from '@exocortex/contracts';
import {
  appendWorkflowRunEvents,
  lockWorkflowRun,
  parseStoredWorkflowGraph,
  type Prisma,
  type PrismaTransactionClient,
  WORKFLOW_RUN_TERMINAL_ROWS,
} from '@exocortex/database';

import {
  DEFAULT_LEASE_MS,
  type NodeContext,
  type NodeOutcome,
  type WorkflowWake,
} from './handlers';
import { type Claim, recordOutcome } from './record';
import {
  advanceJob,
  clock,
  enqueueAll,
  EXECUTION_SELECT,
  handlerFor,
  RUN_SELECT,
  type RunRow,
  type WorkflowRuntimeDependencies,
} from './shared';

/**
 * Executing one node attempt (issue #161, ADR-076): claim it with a lease
 * under the run's lock, call its handler outside any transaction, and record
 * the outcome only if the lease is still this worker's (`record.ts`).
 */

const CLAIM_EXECUTION_SELECT = {
  ...EXECUTION_SELECT,
  idempotencyKey: true,
  availableAt: true,
} satisfies Prisma.WorkflowNodeExecutionSelect;

type ClaimRow = Prisma.WorkflowNodeExecutionGetPayload<{ select: typeof CLAIM_EXECUTION_SELECT }>;

/** Runs one queued attempt. Returns whether this call executed it. */
export async function executeWorkflowNode(
  dependencies: WorkflowRuntimeDependencies,
  executionId: string,
): Promise<boolean> {
  const claimed = await claim(dependencies, { executionId, from: 'QUEUED', wake: null });
  if (claimed === null) return false;
  const outcome = await runHandler(dependencies, claimed);
  await recordOutcome(dependencies, claimed, outcome);
  return true;
}

/** Continues one waiting attempt. Returns whether this call resumed it. */
export async function resumeWorkflowNode(
  dependencies: WorkflowRuntimeDependencies,
  executionId: string,
  wake: WorkflowWake,
): Promise<boolean> {
  const claimed = await claim(dependencies, { executionId, from: 'WAITING', wake });
  if (claimed === null) return false;
  const outcome = await runHandler(dependencies, claimed);
  await recordOutcome(dependencies, claimed, outcome);
  return true;
}

/**
 * Claims one attempt and returns what its handler needs, or null when the
 * attempt is not there to claim: already claimed, finished, not yet due, or
 * its run is over. The claim is a conditional update under the run's lock,
 * so two workers delivered the same job cannot both get it.
 */
async function claim(
  dependencies: WorkflowRuntimeDependencies,
  input: { executionId: string; from: 'QUEUED' | 'WAITING'; wake: WorkflowWake | null },
): Promise<Claim | null> {
  const prisma = dependencies.prisma;
  const head = await prisma.workflowNodeExecution.findUnique({
    where: { id: input.executionId },
    select: { runId: true, run: { select: { workspaceId: true } } },
  });
  if (head === null) return null;
  const settings = await dependencies.settings(head.run.workspaceId);
  if (!settings['workflows.enabled']) {
    // Switched off while the run was in flight: nothing more executes, and
    // the advance is what ends the run and says why.
    await enqueueAll(dependencies, [advanceJob(head.runId, null)]);
    return null;
  }
  const now = clock(dependencies);

  const claimed = await prisma.$transaction(async (tx): Promise<Claim | 'expired' | null> => {
    if (!(await lockWorkflowRun(tx, head.runId, now))) return null;
    const run = await tx.workflowRun.findUniqueOrThrow({
      where: { id: head.runId },
      select: RUN_SELECT,
    });
    if (WORKFLOW_RUN_TERMINAL_ROWS.includes(run.status)) return null;
    // Past its lifetime nothing more executes, not even a step that was due;
    // the advance times the run out.
    if (run.deadlineAt !== null && run.deadlineAt.getTime() <= now.getTime()) return 'expired';
    const graph = parseStoredWorkflowGraph(run.workflowVersion.graph);
    const execution = await tx.workflowNodeExecution.findUniqueOrThrow({
      where: { id: input.executionId },
      select: CLAIM_EXECUTION_SELECT,
    });
    if (graph === null || !claimable(execution, { ...input, now })) return null;
    return takeLease(tx, dependencies, { run, graph, execution, wake: input.wake, now });
  });
  if (claimed === 'expired') {
    await enqueueAll(dependencies, [advanceJob(head.runId, null)]);
    return null;
  }
  return claimed;
}

/** Whether the attempt is in the state the job expects, due, and woken by what it waits for. */
function claimable(
  execution: ClaimRow,
  input: { from: 'QUEUED' | 'WAITING'; wake: WorkflowWake | null; now: Date },
): boolean {
  if (execution.status !== input.from) return false;
  if (input.from === 'QUEUED' && execution.availableAt.getTime() > input.now.getTime()) {
    return false;
  }
  return input.wake === null || wakeMatches(execution.waitingOn, input.wake);
}

/** The conditional update that is the claim, and what the handler will be given. */
async function takeLease(
  tx: PrismaTransactionClient,
  dependencies: WorkflowRuntimeDependencies,
  input: {
    run: RunRow;
    graph: WorkflowGraph;
    execution: ClaimRow;
    wake: WorkflowWake | null;
    now: Date;
  },
): Promise<Claim | null> {
  const { run, graph, execution, wake, now } = input;
  const node = graph.nodes.find((candidate) => candidate.id === execution.nodeId);
  const handler = handlerFor(dependencies, execution.nodeType);
  if (node === undefined || handler === undefined) return null;

  const leaseToken = randomUUID();
  const claimed = await tx.workflowNodeExecution.updateMany({
    where: { id: execution.id, status: execution.status },
    data: {
      status: 'RUNNING',
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + (handler.leaseMs ?? DEFAULT_LEASE_MS)),
      ...(execution.startedAt === null ? { startedAt: now } : {}),
    },
  });
  if (claimed.count !== 1) return null;
  if (run.status !== 'RUNNING') {
    await tx.workflowRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', waitingSince: null },
    });
  }
  await appendWorkflowRunEvents(tx, run.id, [
    {
      type: wake === null ? 'node.started' : 'node.resumed',
      nodeId: execution.nodeId,
      executionId: execution.id,
      attempt: execution.attempt,
      detail: wake === null ? { nodeType: execution.nodeType } : { wake: wake.kind },
      at: now,
    },
  ]);

  return {
    executionId: execution.id,
    leaseToken,
    handler,
    wake,
    context: {
      run: {
        id: run.id,
        workflowId: run.workflowId,
        workspaceId: run.workspaceId,
        startedById: run.startedById,
        chainDepth: run.chainDepth,
        input: run.input,
        correlationId: run.correlationId,
      },
      node,
      execution: {
        id: execution.id,
        attempt: execution.attempt,
        idempotencyKey: execution.idempotencyKey,
      },
      graph,
      outputs: await outputsOf(tx, run.id),
    },
  };
}

function wakeMatches(waitingOn: Prisma.JsonValue, wake: WorkflowWake): boolean {
  const parsed = workflowWaitSchema.safeParse(waitingOn);
  if (!parsed.success) return false;
  const wait: WorkflowWait = parsed.data;
  if (wait.kind !== wake.kind) return false;
  if (wait.kind === 'work_item' && wake.kind === 'work_item') {
    return wait.workItemId === wake.workItemId;
  }
  if (wait.kind === 'attention_item' && wake.kind === 'attention_item') {
    return wait.attentionItemId === wake.attentionItemId;
  }
  return true;
}

/** The output of the latest succeeded attempt of every node of a run. */
async function outputsOf(
  tx: PrismaTransactionClient,
  runId: string,
): Promise<Map<string, Record<string, unknown> | null>> {
  const rows = await tx.workflowNodeExecution.findMany({
    where: { runId, status: 'SUCCEEDED' },
    select: { nodeId: true, attempt: true, output: true },
    orderBy: { attempt: 'asc' },
  });
  const outputs = new Map<string, Record<string, unknown> | null>();
  for (const row of rows) {
    const value = row.output;
    outputs.set(
      row.nodeId,
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null,
    );
  }
  return outputs;
}

/**
 * Calls the handler outside any transaction. A throw is a failure of the
 * node, never of the job: retryable only when the handler is idempotent,
 * because otherwise a second try could repeat what the first already did.
 */
async function runHandler(
  dependencies: WorkflowRuntimeDependencies,
  claimed: Claim,
): Promise<NodeOutcome> {
  const logger = dependencies.logger.child({
    workflowRunId: claimed.context.run.id,
    nodeId: claimed.context.node.id,
    attempt: claimed.context.execution.attempt,
  });
  const context: NodeContext = { ...claimed.context, logger };
  try {
    if (claimed.wake === null) return await claimed.handler.execute(context);
    if (claimed.handler.resume === undefined) {
      return {
        status: 'failed',
        errorClass: 'terminal',
        code: 'workflow_resume_unsupported',
        message: `A ${claimed.context.node.type} node cannot be resumed by ${claimed.wake.kind}`,
      };
    }
    return await claimed.handler.resume(context, claimed.wake);
  } catch (error) {
    logger.warn('A workflow node handler threw', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: 'failed',
      errorClass: claimed.handler.idempotent ? 'retryable' : 'terminal',
      code: 'workflow_node_error',
      message: 'The node failed with an unexpected error',
    };
  }
}
