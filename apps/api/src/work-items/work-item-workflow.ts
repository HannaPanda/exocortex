import {
  type AiWriteMode,
  type CreateWorkItemRequest,
  strictestWriteMode,
  type WorkflowNodeOf,
  type WorkflowOutputField,
  type WorkItemDetail,
} from '@exocortex/contracts';
import { parseStoredWorkflowGraph, type PrismaClient } from '@exocortex/database';

import { currentWorkflowOrigin } from '../common/correlation';

/**
 * The work item side of a workflow's agent node (issue #162).
 *
 * The worker creates the node's work through the ordinary routes, as the
 * person the run acts for, with the workflow origin header on its own
 * service token (`SessionGuard` forgets the header on any other credential).
 * What that header may change here is narrow and checked against the rows,
 * never taken from the request: which attempt the item belongs to, and that
 * the profile it names is the one the published version names for that node.
 */

/** The agent node attempt that is writing, verified against its run, or undefined. */
export interface VerifiedWorkflowNode {
  executionId: string;
  runId: string;
  workflowId: string;
  node: WorkflowNodeOf<'agent'>;
}

/**
 * The agent node the current request is acting for, when the workflow origin
 * names one that is executing right now in this workspace, for this person.
 *
 * Every link is checked: the attempt belongs to the run the header names,
 * the run to the workflow and the workspace, the run acts as the caller, the
 * attempt holds a lease (`RUNNING`), and the node in the run's own version is
 * an agent node. A header that fails any of it is no origin at all.
 */
export async function verifiedWorkflowNode(
  prisma: PrismaClient,
  workspaceId: string,
  userId: string,
): Promise<VerifiedWorkflowNode | undefined> {
  const origin = currentWorkflowOrigin();
  if (origin === undefined) return undefined;
  const execution = await prisma.workflowNodeExecution.findUnique({
    where: { id: origin.executionId },
    select: {
      id: true,
      nodeId: true,
      nodeType: true,
      status: true,
      run: {
        select: {
          id: true,
          workflowId: true,
          workspaceId: true,
          startedById: true,
          workflowVersion: { select: { graph: true } },
        },
      },
    },
  });
  if (
    execution === null ||
    execution.nodeType !== 'agent' ||
    execution.status !== 'RUNNING' ||
    execution.run.id !== origin.runId ||
    execution.run.workflowId !== origin.workflowId ||
    execution.run.workspaceId !== workspaceId ||
    execution.run.startedById !== userId
  ) {
    return undefined;
  }
  const graph = parseStoredWorkflowGraph(execution.run.workflowVersion.graph);
  const node = graph?.nodes.find((candidate) => candidate.id === execution.nodeId);
  if (node?.type !== 'agent') return undefined;
  return {
    executionId: execution.id,
    runId: execution.run.id,
    workflowId: execution.run.workflowId,
    node,
  };
}

/**
 * The item a retried attempt already created, so its second delivery gets
 * the first one's item back instead of a second piece of work.
 */
export async function itemMadeBy(
  prisma: PrismaClient,
  workflowNode: VerifiedWorkflowNode | undefined,
): Promise<string | null> {
  if (workflowNode === undefined) return null;
  const made = await prisma.workItem.findUnique({
    where: { workflowExecutionId: workflowNode.executionId },
    select: { id: true },
  });
  return made?.id ?? null;
}

/**
 * What the published version says about the node holds whatever the request
 * sent: its fields are the result's, and its write mode is combined with
 * the requested one by taking the stricter, never by replacing it.
 */
export function nodeTerms(
  workflowNode: VerifiedWorkflowNode | undefined,
  request: Pick<CreateWorkItemRequest, 'resultFields' | 'writeMode'>,
): { resultFields: WorkflowOutputField[]; writeMode: AiWriteMode | null } {
  const requested = request.writeMode ?? null;
  if (workflowNode === undefined) {
    return { resultFields: request.resultFields ?? [], writeMode: requested };
  }
  const own = workflowNode.node.writeMode;
  return {
    resultFields: workflowNode.node.outputFields,
    writeMode: requested === null && own === null ? null : strictestWriteMode(requested, own),
  };
}

/** Where the item came from, while the attempt that created it still exists. */
export async function workflowOriginOf(
  prisma: PrismaClient,
  executionId: string | null,
): Promise<WorkItemDetail['workflow']> {
  if (executionId === null) return null;
  const execution = await prisma.workflowNodeExecution.findUnique({
    where: { id: executionId },
    select: { nodeId: true, run: { select: { id: true, workflowId: true } } },
  });
  if (execution === null) return null;
  return {
    workflowId: execution.run.workflowId,
    runId: execution.run.id,
    nodeId: execution.nodeId,
  };
}
