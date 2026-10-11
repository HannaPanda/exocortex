import {
  agentProfileSnapshotSchema,
  checkStructuredResult,
  describeStructuredResultProblems,
  resultFieldsSchema,
  type StructuredResult,
  structuredResultSchema,
  WORKFLOW_RESULT_SUMMARY_MAX_CHARS,
  type WorkflowAgentResult,
  type WorkflowNodeOf,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';

/**
 * When an agent node's work counts as finished (issue #162, ADR-077).
 *
 * A run ending is not the work ending: the work item's status is a decision
 * somebody makes (ADR-066), so this reads the item, never the run, and the
 * rules are these:
 *
 * - `done` completes the node, whatever its `completion` says.
 * - `review` completes it when the node asked for `review`, the required
 *   fields are filled in, no proposal waits to be applied, and the run did
 *   not work under a profile that wants a person to close the work. Anything
 *   else in review is a person's turn, and the node waits for them.
 * - `failed` and `cancelled` fail it; so does the item being gone.
 * - Everything open waits, unless nothing can move it any more: no run
 *   pending or running, no children awaited, no person asked, and the last
 *   run ended a while ago. That is `stalled`, and failing it is the honest
 *   answer rather than a node that waits until its run times out.
 *
 * Pure over a snapshot of the item, so the handler that resumes the node
 * and the sweep that decides whether a resume is worth queueing cannot
 * disagree.
 */

/** How long after its last run ended open work may sit before it counts as stalled. */
export const STALL_AFTER_MS = 3 * 60_000;

export const AGENT_WORK_SELECT = {
  id: true,
  status: true,
  result: true,
  resultFields: true,
  structuredResult: true,
  awaitingSince: true,
  refs: { select: { role: true, documentId: true }, orderBy: { createdAt: 'asc' } },
  runs: {
    select: { id: true, status: true, finishedAt: true, agentProfileSnapshot: true },
    orderBy: { createdAt: 'desc' },
    take: 5,
  },
  changesets: {
    where: { status: { in: ['DRAFT', 'READY', 'PARTIALLY_APPLIED'] } },
    select: { id: true },
    take: 1,
  },
} satisfies Prisma.WorkItemSelect;

export type AgentWork = Prisma.WorkItemGetPayload<{ select: typeof AGENT_WORK_SELECT }>;

export async function loadAgentWork(
  prisma: PrismaClient,
  workItemId: string,
): Promise<AgentWork | null> {
  return prisma.workItem.findUnique({ where: { id: workItemId }, select: AGENT_WORK_SELECT });
}

export type AgentCompletion =
  | { kind: 'wait' }
  | { kind: 'complete'; outcome: 'review' | 'done'; fields: StructuredResult }
  | {
      kind: 'fail';
      code:
        | 'workflow_work_item_failed'
        | 'workflow_work_item_cancelled'
        | 'workflow_work_item_gone'
        | 'workflow_work_item_stalled'
        | 'workflow_output_invalid';
      message: string;
    };

const ACTIVE_RUN_STATUSES: readonly string[] = ['PENDING', 'RUNNING'];

export function agentCompletion(
  node: Pick<WorkflowNodeOf<'agent'>, 'completion' | 'outputFields'>,
  work: AgentWork | null,
  now: Date,
): AgentCompletion {
  if (work === null) {
    return {
      kind: 'fail',
      code: 'workflow_work_item_gone',
      message: 'The work item was deleted while the workflow waited for it',
    };
  }
  switch (work.status) {
    case 'FAILED':
      return { kind: 'fail', code: 'workflow_work_item_failed', message: 'The work failed' };
    case 'CANCELLED':
      return {
        kind: 'fail',
        code: 'workflow_work_item_cancelled',
        message: 'The work was cancelled',
      };
    case 'DONE':
      return completeWith(node, work, 'done');
    case 'REVIEW':
      return handedIn(node, work);
    case 'WAITING_FOR_HUMAN':
    case 'BLOCKED':
      return { kind: 'wait' };
    case 'QUEUED':
    case 'WORKING':
      return stalled(work, now)
        ? {
            kind: 'fail',
            code: 'workflow_work_item_stalled',
            message: 'The work is open, but no run is working on it and it waits for nothing',
          }
        : { kind: 'wait' };
  }
}

/** In review: complete only when nobody still has to decide anything about it. */
function handedIn(
  node: Pick<WorkflowNodeOf<'agent'>, 'completion' | 'outputFields'>,
  work: AgentWork,
): AgentCompletion {
  if (node.completion !== 'review') return { kind: 'wait' };
  if (work.changesets.length > 0) return { kind: 'wait' };
  const snapshot = agentProfileSnapshotSchema.safeParse(work.runs[0]?.agentProfileSnapshot);
  if (snapshot.success && snapshot.data.approvalPolicy === 'review_before_done') {
    return { kind: 'wait' };
  }
  // Handed in without the fields (a review asked for directly): a person can
  // send it back or accept it, so this is their turn, not a failure yet.
  const fields = declaredFields(node, work);
  if (checkStructuredResult(fields, valuesOf(work), { complete: true }).length > 0) {
    return { kind: 'wait' };
  }
  return completeWith(node, work, 'review');
}

function completeWith(
  node: Pick<WorkflowNodeOf<'agent'>, 'outputFields'>,
  work: AgentWork,
  outcome: 'review' | 'done',
): AgentCompletion {
  const values = valuesOf(work);
  const problems = checkStructuredResult(declaredFields(node, work), values, { complete: true });
  if (problems.length > 0) {
    return {
      kind: 'fail',
      code: 'workflow_output_invalid',
      message: `The structured result does not match the node's fields (${describeStructuredResultProblems(problems)})`,
    };
  }
  return { kind: 'complete', outcome, fields: values ?? {} };
}

/**
 * The node's own fields are the contract. The item carries a copy made when
 * it was created; the node is what the graph's conditions were checked
 * against, so a value is trusted only against that.
 */
function declaredFields(node: Pick<WorkflowNodeOf<'agent'>, 'outputFields'>, work: AgentWork) {
  if (node.outputFields.length > 0) return node.outputFields;
  const stored = resultFieldsSchema.safeParse(work.resultFields);
  return stored.success ? stored.data : [];
}

function valuesOf(work: AgentWork): StructuredResult | null {
  if (work.structuredResult === null) return null;
  const parsed = structuredResultSchema.safeParse(work.structuredResult);
  // Something that does not even parse is reported field by field by the
  // check, which gets the raw object.
  if (parsed.success) return parsed.data;
  return typeof work.structuredResult === 'object' && !Array.isArray(work.structuredResult)
    ? (work.structuredResult as StructuredResult)
    : null;
}

function stalled(work: AgentWork, now: Date): boolean {
  if (work.awaitingSince !== null) return false;
  if (work.runs.some((run) => ACTIVE_RUN_STATUSES.includes(run.status))) return false;
  const last = work.runs[0];
  // No run at all: the node starts one right after creating the item, so
  // this is a start that has not been recorded yet, never a stall.
  if (last === undefined) return false;
  const endedAt = last.finishedAt?.getTime() ?? now.getTime();
  return now.getTime() - endedAt >= STALL_AFTER_MS;
}

/** What a completed node leaves for the nodes after it. */
export function agentResult(input: {
  work: AgentWork;
  outcome: 'review' | 'done';
  fields: StructuredResult;
  spentMicroUsd: number;
}): WorkflowAgentResult {
  const { work } = input;
  const ids = (role: 'CONTEXT' | 'RESULT') =>
    work.refs.filter((ref) => ref.role === role).map((ref) => ref.documentId);
  return {
    outcome: input.outcome,
    fields: input.fields,
    workItemId: work.id,
    aiRunId: work.runs[0]?.id ?? null,
    resultDocumentIds: ids('RESULT'),
    contextDocumentIds: ids('CONTEXT'),
    summary:
      work.result === null || work.result.length === 0
        ? null
        : work.result.slice(0, WORKFLOW_RESULT_SUMMARY_MAX_CHARS),
    spentMicroUsd: input.spentMicroUsd,
  };
}
