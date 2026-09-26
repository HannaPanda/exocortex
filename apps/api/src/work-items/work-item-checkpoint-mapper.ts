import {
  type WorkCheckpoint,
  type WorkCheckpointDecision,
  type WorkCheckpointRef,
  type WorkCheckpointTrigger,
} from '@exocortex/contracts';
import {
  parseCheckpointRefs,
  parseCheckpointState,
  type Prisma,
  type PrismaClient,
  type WorkItemCheckpointTrigger as PrismaTrigger,
} from '@exocortex/database';

import { KIND_FROM_PRISMA, STATUS_FROM } from '../attention/attention-mapper';

import { PARTICIPANT_FROM_PRISMA } from './work-item-mapper';

/**
 * Between checkpoint rows and the wire (issue #142).
 *
 * A row stores pages by id and revision and decisions by id; a reader is shown
 * them as they are now -- the page's title and whether it moved on, the
 * decision's status -- because "was it answered since" and "did the page
 * change since" are exactly what a resume has to know.
 */

export const TRIGGER_FROM_PRISMA: Record<PrismaTrigger, WorkCheckpointTrigger> = {
  STEP: 'step',
  PAUSE: 'pause',
  WAITING_FOR_HUMAN: 'waiting_for_human',
  EXTERNAL_WAIT: 'external_wait',
  BUDGET: 'budget',
  RUN_INTERRUPTED: 'run_interrupted',
};
export const TRIGGER_TO_PRISMA: Record<WorkCheckpointTrigger, PrismaTrigger> = {
  step: 'STEP',
  pause: 'PAUSE',
  waiting_for_human: 'WAITING_FOR_HUMAN',
  external_wait: 'EXTERNAL_WAIT',
  budget: 'BUDGET',
  run_interrupted: 'RUN_INTERRUPTED',
};

export const CHECKPOINT_SELECT = {
  id: true,
  workItemId: true,
  aiRunId: true,
  trigger: true,
  authorKind: true,
  authorId: true,
  author: { select: { name: true } },
  agentLabel: true,
  system: true,
  summary: true,
  state: true,
  refs: true,
  pendingAttentionIds: true,
  interruptionCode: true,
  spentMicroUsd: true,
  budgetMicroUsd: true,
  provider: true,
  model: true,
  createdAt: true,
} satisfies Prisma.WorkItemCheckpointSelect;

export type CheckpointRow = Prisma.WorkItemCheckpointGetPayload<{
  select: typeof CHECKPOINT_SELECT;
}>;

/** What the rows point at, looked up once for however many rows are shown. */
interface Lookups {
  pages: Map<string, { title: string; revision: string | null }>;
  decisions: Map<string, WorkCheckpointDecision>;
}

async function lookupsFor(
  prisma: PrismaClient,
  workspaceId: string,
  rows: readonly CheckpointRow[],
): Promise<Lookups> {
  const pageIds = [
    ...new Set(rows.flatMap((row) => parseCheckpointRefs(row.refs).map((ref) => ref.documentId))),
  ];
  const decisionIds = [...new Set(rows.flatMap((row) => row.pendingAttentionIds))];
  const [pages, decisions] = await Promise.all([
    pageIds.length === 0
      ? []
      : prisma.document.findMany({
          // The workspace is the item's, so a page moved elsewhere reads as gone.
          where: { id: { in: pageIds }, workspaceId },
          select: { id: true, title: true, content: { select: { yjsUpdatedAt: true } } },
        }),
    decisionIds.length === 0
      ? []
      : prisma.attentionItem.findMany({
          where: { id: { in: decisionIds } },
          select: { id: true, title: true, kind: true, status: true },
        }),
  ]);
  return {
    pages: new Map(
      pages.map((page) => [
        page.id,
        { title: page.title, revision: page.content?.yjsUpdatedAt.toISOString() ?? null },
      ]),
    ),
    decisions: new Map(
      decisions.map((row) => [
        row.id,
        {
          attentionItemId: row.id,
          title: row.title,
          kind: KIND_FROM_PRISMA[row.kind],
          status: STATUS_FROM[row.status],
        },
      ]),
    ),
  };
}

function toCheckpoint(row: CheckpointRow, lookups: Lookups): WorkCheckpoint {
  const state = parseCheckpointState(row.state);
  const refs: WorkCheckpointRef[] = parseCheckpointRefs(row.refs).map((ref) => {
    const page = lookups.pages.get(ref.documentId);
    return {
      ...ref,
      title: page?.title ?? null,
      changedSince: page !== undefined && page.revision !== ref.revision,
    };
  });
  return {
    id: row.id,
    workItemId: row.workItemId,
    runId: row.aiRunId,
    trigger: TRIGGER_FROM_PRISMA[row.trigger],
    author: {
      kind: PARTICIPANT_FROM_PRISMA[row.authorKind],
      userId: row.authorId,
      name: row.author?.name ?? null,
    },
    agentLabel: row.agentLabel,
    system: row.system,
    summary: row.summary,
    ...state,
    refs,
    pendingDecisions: row.pendingAttentionIds.flatMap((id) => {
      const decision = lookups.decisions.get(id);
      return decision === undefined ? [] : [decision];
    }),
    interruptionCode: row.interruptionCode,
    spentMicroUsd: row.spentMicroUsd,
    budgetMicroUsd: row.budgetMicroUsd,
    provider: row.provider,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function toCheckpoints(
  prisma: PrismaClient,
  workspaceId: string,
  rows: readonly CheckpointRow[],
): Promise<WorkCheckpoint[]> {
  const lookups = await lookupsFor(prisma, workspaceId, rows);
  return rows.map((row) => toCheckpoint(row, lookups));
}
