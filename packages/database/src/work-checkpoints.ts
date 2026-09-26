import {
  type StoredWorkCheckpointRef,
  storedWorkCheckpointRefSchema,
  type WorkCheckpointState,
  workCheckpointStateSchema,
} from '@exocortex/contracts';

import {
  type Prisma,
  type PrismaClient,
  type PrismaTransactionClient,
  type WorkItemCheckpointTrigger,
  type WorkItemParticipantKind,
} from './client';

/**
 * Recording where a piece of work stands (issue #142, ADR-069), shared by the
 * API and the worker.
 *
 * The API records what the worker of a task says, and a checkpoint of its own
 * when the work starts waiting on a person; the worker's sweep records one when
 * a run behind the work ended without finishing it. All of them carry forward
 * what the previous checkpoint said and the caller left out, snapshot the
 * budget, the pending decisions and the run's model, and write the history line
 * in the same transaction. That is one rule in three callers, so it lives here.
 */

/** What a caller changes; everything left `undefined` is carried forward. */
export interface WorkCheckpointChanges {
  summary?: string;
  plan?: WorkCheckpointState['plan'];
  assumptions?: string[];
  findings?: string[];
  lastAction?: string | null;
  nextStep?: string | null;
}

export interface WorkCheckpointDraft {
  workItemId: string;
  aiRunId: string | null;
  trigger: WorkItemCheckpointTrigger;
  authorKind: WorkItemParticipantKind;
  authorId: string | null;
  agentLabel: string | null;
  system: boolean;
  changes: WorkCheckpointChanges;
  /** Page lists that replace the previous ones; `undefined` keeps them. */
  artifactDocumentIds?: readonly string[];
  sourceDocumentIds?: readonly string[];
  interruptionCode?: string | null;
  correlationId: string;
}

/** The stored state, read defensively: a row that does not parse carries nothing. */
export function parseCheckpointState(value: Prisma.JsonValue | undefined): WorkCheckpointState {
  const parsed = workCheckpointStateSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : workCheckpointStateSchema.parse({});
}

export function parseCheckpointRefs(
  value: Prisma.JsonValue | undefined,
): StoredWorkCheckpointRef[] {
  const parsed = storedWorkCheckpointRefSchema.array().safeParse(value ?? []);
  return parsed.success ? parsed.data : [];
}

/** The previous state with the caller's changes laid over it. Pure. */
export function mergeCheckpointState(
  previous: { summary: string; state: WorkCheckpointState } | null,
  changes: WorkCheckpointChanges,
): { summary: string; state: WorkCheckpointState } {
  const base = previous?.state ?? workCheckpointStateSchema.parse({});
  return {
    summary: changes.summary ?? previous?.summary ?? '',
    state: {
      plan: changes.plan ?? base.plan,
      assumptions: changes.assumptions ?? base.assumptions,
      findings: changes.findings ?? base.findings,
      lastAction: changes.lastAction === undefined ? base.lastAction : changes.lastAction,
      nextStep: changes.nextStep === undefined ? base.nextStep : changes.nextStep,
    },
  };
}

/**
 * Replaces the pages of one role with `documentIds` at their revision now, and
 * keeps the other role's pages as they were recorded.
 */
async function nextRefs(
  client: PrismaClient | PrismaTransactionClient,
  previous: readonly StoredWorkCheckpointRef[],
  draft: Pick<WorkCheckpointDraft, 'artifactDocumentIds' | 'sourceDocumentIds'>,
): Promise<StoredWorkCheckpointRef[]> {
  const replaced = new Map<StoredWorkCheckpointRef['role'], readonly string[]>();
  if (draft.artifactDocumentIds !== undefined) replaced.set('artifact', draft.artifactDocumentIds);
  if (draft.sourceDocumentIds !== undefined) replaced.set('source', draft.sourceDocumentIds);
  const ids = [...new Set([...replaced.values()].flat())];
  const revisions = new Map(
    ids.length === 0
      ? []
      : (
          await client.documentContent.findMany({
            where: { documentId: { in: ids } },
            select: { documentId: true, yjsUpdatedAt: true },
          })
        ).map((row) => [row.documentId, row.yjsUpdatedAt.toISOString()]),
  );
  const refs: StoredWorkCheckpointRef[] = [];
  for (const role of ['artifact', 'source'] as const) {
    const fresh = replaced.get(role);
    if (fresh === undefined) {
      refs.push(...previous.filter((ref) => ref.role === role));
      continue;
    }
    for (const documentId of new Set(fresh)) {
      refs.push({ documentId, role, revision: revisions.get(documentId) ?? null });
    }
  }
  return refs;
}

/**
 * Writes a checkpoint and its history line. Returns the new row's id, or null
 * when an interruption of the same run was already recorded (the partial
 * unique index makes the second one nothing).
 */
export async function recordWorkCheckpoint(
  tx: PrismaTransactionClient,
  draft: WorkCheckpointDraft,
): Promise<string | null> {
  const item = await tx.workItem.findUniqueOrThrow({
    where: { id: draft.workItemId },
    select: {
      budgetMicroUsd: true,
      runs: { select: { providerCostMicroUsd: true, estimatedCostMicroUsd: true } },
      checkpoints: {
        select: { summary: true, state: true, refs: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      attention: { where: { status: 'OPEN' }, select: { id: true } },
    },
  });
  const previousRow = item.checkpoints[0] ?? null;
  const merged = mergeCheckpointState(
    previousRow === null
      ? null
      : { summary: previousRow.summary, state: parseCheckpointState(previousRow.state) },
    draft.changes,
  );
  const refs = await nextRefs(tx, parseCheckpointRefs(previousRow?.refs), draft);
  const run =
    draft.aiRunId === null
      ? null
      : await tx.aiRun.findUnique({
          where: { id: draft.aiRunId },
          select: { provider: true, model: true },
        });

  const [created] = await tx.workItemCheckpoint.createManyAndReturn({
    data: [
      {
        workItemId: draft.workItemId,
        aiRunId: run === null ? null : draft.aiRunId,
        trigger: draft.trigger,
        authorKind: draft.authorKind,
        authorId: draft.authorId,
        agentLabel: draft.agentLabel,
        system: draft.system,
        summary: merged.summary,
        state: merged.state,
        refs,
        pendingAttentionIds: item.attention.map((entry) => entry.id),
        interruptionCode: draft.interruptionCode ?? null,
        spentMicroUsd: item.runs.reduce(
          (sum, entry) => sum + (entry.providerCostMicroUsd ?? entry.estimatedCostMicroUsd ?? 0),
          0,
        ),
        budgetMicroUsd: item.budgetMicroUsd,
        provider: run?.provider ?? null,
        model: run?.model ?? null,
      },
    ],
    // ON CONFLICT DO NOTHING: the one interruption a run may have.
    skipDuplicates: true,
    select: { id: true },
  });
  if (created === undefined) return null;

  await tx.workItem.update({ where: { id: draft.workItemId }, data: { updatedAt: new Date() } });
  await tx.workItemEvent.create({
    data: {
      workItemId: draft.workItemId,
      actorKind: draft.authorKind,
      actorId: draft.authorId,
      agentLabel: draft.agentLabel,
      correlationId: draft.correlationId,
      kind: 'CHECKPOINT_RECORDED',
      data: { checkpointId: created.id, trigger: draft.trigger.toLowerCase() },
    },
  });
  return created.id;
}
