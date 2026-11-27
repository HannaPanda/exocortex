import { type DatabaseRowAiCell } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { cellErrorCode } from './ai-fill-mapper';

/** A stored value as far as its AI mark is concerned. */
export interface AiMarkedValue {
  documentId: string;
  propertyId: string;
  aiRunId: string | null;
  updatedAt: Date;
}

const ACTIVE_RUN = ['PENDING', 'RUNNING'] as const;

/**
 * What the AI fill has to say about the cells of these rows (issue #237), per
 * row, for the table and a row's page header.
 *
 * Three sources, in this order of precedence:
 *
 *   1. a batch that is still working on the cell makes it `pending`;
 *   2. the latest finished attempt, when it failed or found nothing and nobody
 *      wrote the cell after it, makes it `failed` or `empty`;
 *   3. a value carrying a run's id is `filled` -- the id is cleared by every
 *      other write, so the mark cannot outlive a person's edit.
 *
 * One indexed read of the cell table for the whole page of rows. A database
 * nobody ever filled answers from the values alone.
 */
export async function aiCellsOfRows(
  prisma: PrismaClient,
  rowIds: readonly string[],
  values: readonly AiMarkedValue[],
): Promise<Map<string, DatabaseRowAiCell[]>> {
  const byRow = new Map<string, DatabaseRowAiCell[]>();
  if (rowIds.length === 0) return byRow;

  const attempts = await prisma.databaseAiFillCell.findMany({
    where: { rowId: { in: [...rowIds] } },
    orderBy: [{ createdAt: 'desc' }],
    distinct: ['rowId', 'propertyId'],
    select: {
      rowId: true,
      propertyId: true,
      aiRunId: true,
      status: true,
      errorCode: true,
      finishedAt: true,
      run: { select: { aiRun: { select: { status: true } } } },
    },
  });

  const valueOf = new Map(
    values.map((value) => [`${value.documentId}:${value.propertyId}`, value]),
  );
  const decided = new Set<string>();
  const push = (rowId: string, cell: DatabaseRowAiCell): void => {
    decided.add(`${rowId}:${cell.propertyId}`);
    const list = byRow.get(rowId);
    if (list === undefined) byRow.set(rowId, [cell]);
    else list.push(cell);
  };

  for (const attempt of attempts) {
    const key = `${attempt.rowId}:${attempt.propertyId}`;
    const active = (ACTIVE_RUN as readonly string[]).includes(attempt.run.aiRun.status);
    if (active && (attempt.status === 'QUEUED' || attempt.status === 'RUNNING')) {
      push(attempt.rowId, {
        propertyId: attempt.propertyId,
        state: 'pending',
        runId: attempt.aiRunId,
        at: null,
        errorCode: null,
      });
      continue;
    }
    if (
      (attempt.status !== 'FAILED' && attempt.status !== 'EMPTY') ||
      attempt.finishedAt === null
    ) {
      continue;
    }
    const value = valueOf.get(key);
    // A person (or a later fill) wrote the cell after this attempt: its
    // failure is no longer what the cell is about.
    if (value !== undefined && value.updatedAt > attempt.finishedAt) continue;
    push(attempt.rowId, {
      propertyId: attempt.propertyId,
      state: attempt.status === 'FAILED' ? 'failed' : 'empty',
      runId: attempt.aiRunId,
      at: attempt.finishedAt.toISOString(),
      errorCode: attempt.status === 'FAILED' ? cellErrorCode(attempt.errorCode) : null,
    });
  }

  for (const value of values) {
    if (value.aiRunId === null) continue;
    const key = `${value.documentId}:${value.propertyId}`;
    if (decided.has(key)) continue;
    push(value.documentId, {
      propertyId: value.propertyId,
      state: 'filled',
      runId: value.aiRunId,
      at: value.updatedAt.toISOString(),
      errorCode: null,
    });
  }
  return byRow;
}
