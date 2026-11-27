import {
  type AiAutoFill,
  type AiFillCell,
  type AiFillCellErrorCode,
  aiFillCellErrorCodeSchema,
  type AiFillCellStatus,
  type AiFillCounts,
  type AiFillMode,
  type AiFillOrigin,
  type AiFillPreset,
  type AiFillRun,
  type AiRunStatus,
  type DatabasePropertyAi,
} from '@exocortex/contracts';
import { type Prisma } from '@exocortex/database';

/**
 * The AI fill's rows on the wire (issue #237). Prisma's enums are upper case,
 * the contract's lower case, and these are the only functions that cross.
 */

type PresetColumn = Prisma.DatabasePropertyAiGetPayload<object>['preset'];
type AutoFillColumn = Prisma.DatabasePropertyAiGetPayload<object>['autoFill'];
type ModeColumn = Prisma.DatabaseAiFillRunGetPayload<object>['mode'];
type CellStatusColumn = Prisma.DatabaseAiFillCellGetPayload<object>['status'];
type RunStatusColumn = Prisma.AiRunGetPayload<object>['status'];

export function presetFromColumn(preset: PresetColumn): AiFillPreset {
  return preset.toLowerCase() as AiFillPreset;
}

export function presetToColumn(preset: AiFillPreset): PresetColumn {
  return preset.toUpperCase() as PresetColumn;
}

export function autoFillFromColumn(autoFill: AutoFillColumn): AiAutoFill {
  return autoFill.toLowerCase() as AiAutoFill;
}

export function autoFillToColumn(autoFill: AiAutoFill): AutoFillColumn {
  return autoFill.toUpperCase() as AutoFillColumn;
}

export function modeFromColumn(mode: ModeColumn): AiFillMode {
  return mode.toLowerCase() as AiFillMode;
}

export function modeToColumn(mode: AiFillMode): ModeColumn {
  return mode.toUpperCase() as ModeColumn;
}

export function cellStatusFromColumn(status: CellStatusColumn): AiFillCellStatus {
  return status.toLowerCase() as AiFillCellStatus;
}

export function runStatusFromColumn(status: RunStatusColumn): AiRunStatus {
  return status.toLowerCase() as AiRunStatus;
}

/** A stored code, or null for one this build does not know (a row from a newer one). */
export function cellErrorCode(code: string | null): AiFillCellErrorCode | null {
  if (code === null) return null;
  const parsed = aiFillCellErrorCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : null;
}

export function toPropertyAiResponse(
  row: Prisma.DatabasePropertyAiGetPayload<object>,
): DatabasePropertyAi {
  return {
    preset: presetFromColumn(row.preset),
    instruction: row.instruction,
    targetLanguage: row.targetLanguage,
    allowNewOptions: row.allowNewOptions,
    useContent: row.useContent,
    useProperties: row.useProperties,
    useAttachments: row.useAttachments,
    autoFill: autoFillFromColumn(row.autoFill),
    updatedById: row.updatedById,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const AI_FILL_RUN_INCLUDE = {
  aiRun: {
    select: {
      status: true,
      errorCode: true,
      createdById: true,
      model: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      providerCostMicroUsd: true,
      estimatedCostMicroUsd: true,
      usedOwnKey: true,
    },
  },
  property: { select: { name: true } },
} as const;

export type AiFillRunRow = Prisma.DatabaseAiFillRunGetPayload<{
  include: typeof AI_FILL_RUN_INCLUDE;
}>;

export function emptyCounts(): AiFillCounts {
  return {
    total: 0,
    queued: 0,
    running: 0,
    filled: 0,
    empty: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
  };
}

/** Counts of a batch's cells by status, from a `groupBy`. */
export function countsFrom(
  groups: readonly { status: CellStatusColumn; _count: { _all: number } }[],
): AiFillCounts {
  const counts = emptyCounts();
  for (const group of groups) {
    counts[cellStatusFromColumn(group.status)] += group._count._all;
    counts.total += group._count._all;
  }
  return counts;
}

export function toAiFillRunResponse(row: AiFillRunRow, counts: AiFillCounts): AiFillRun {
  const run = row.aiRun;
  return {
    id: row.aiRunId,
    databaseId: row.databaseId,
    propertyId: row.propertyId,
    propertyName: row.property.name,
    mode: modeFromColumn(row.mode),
    origin: row.origin.toLowerCase() as AiFillOrigin,
    status: runStatusFromColumn(run.status),
    errorCode: run.errorCode,
    createdById: run.createdById,
    model: run.model,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    counts,
    costMicroUsd: run.providerCostMicroUsd ?? run.estimatedCostMicroUsd,
    usedOwnKey: run.usedOwnKey,
  };
}

export function toAiFillCellResponse(
  cell: Prisma.DatabaseAiFillCellGetPayload<object>,
  rowTitle: string,
): AiFillCell {
  return {
    id: cell.id,
    rowId: cell.rowId,
    rowTitle,
    status: cellStatusFromColumn(cell.status),
    errorCode: cellErrorCode(cell.errorCode),
    finishedAt: cell.finishedAt?.toISOString() ?? null,
  };
}
