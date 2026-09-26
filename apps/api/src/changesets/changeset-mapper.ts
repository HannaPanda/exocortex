import {
  type ChangesetChange,
  type ChangesetChangeKind,
  type ChangesetChangeStatus,
  type ChangesetCounts,
  type ChangesetDetail,
  type ChangesetDiff,
  changesetDiffSchema,
  type ChangesetStatus,
  type ChangesetSummary,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';

import {
  PARTICIPANT_FROM_PRISMA,
  STATUS_FROM_PRISMA as WORK_ITEM_STATUS_FROM_PRISMA,
} from '../work-items/work-item-mapper';

type PrismaStatus = Prisma.ChangesetGetPayload<{ select: { status: true } }>['status'];
type PrismaChangeKind = Prisma.ChangesetChangeGetPayload<{ select: { kind: true } }>['kind'];
type PrismaChangeStatus = Prisma.ChangesetChangeGetPayload<{ select: { status: true } }>['status'];

export const STATUS_TO_PRISMA: Record<ChangesetStatus, PrismaStatus> = {
  draft: 'DRAFT',
  ready: 'READY',
  partially_applied: 'PARTIALLY_APPLIED',
  applied: 'APPLIED',
  rejected: 'REJECTED',
  stale: 'STALE',
};

const STATUS_FROM_PRISMA: Record<PrismaStatus, ChangesetStatus> = {
  DRAFT: 'draft',
  READY: 'ready',
  PARTIALLY_APPLIED: 'partially_applied',
  APPLIED: 'applied',
  REJECTED: 'rejected',
  STALE: 'stale',
};

export const KIND_TO_PRISMA: Record<ChangesetChangeKind, PrismaChangeKind> = {
  block: 'BLOCK',
  section: 'SECTION',
  patch: 'PATCH',
  page: 'PAGE',
  create: 'CREATE',
};

export const KIND_FROM_PRISMA: Record<PrismaChangeKind, ChangesetChangeKind> = {
  BLOCK: 'block',
  SECTION: 'section',
  PATCH: 'patch',
  PAGE: 'page',
  CREATE: 'create',
};

export const CHANGE_STATUS_FROM_PRISMA: Record<PrismaChangeStatus, ChangesetChangeStatus> = {
  PENDING: 'pending',
  APPLIED: 'applied',
  REJECTED: 'rejected',
  STALE: 'stale',
};

const USER_NAME = { select: { id: true, name: true } } as const;

export const CHANGE_SELECT = {
  id: true,
  position: true,
  kind: true,
  documentId: true,
  parentId: true,
  title: true,
  request: true,
  message: true,
  baseRevision: true,
  expectedRevision: true,
  diff: true,
  status: true,
  decidedAt: true,
  decidedByKind: true,
  decidedById: true,
  decidedBy: USER_NAME,
  decisionNote: true,
  errorCode: true,
  snapshotId: true,
  createdDocumentId: true,
} satisfies Prisma.ChangesetChangeSelect;

export type ChangeRow = Prisma.ChangesetChangeGetPayload<{ select: typeof CHANGE_SELECT }>;

export const CHANGESET_SUMMARY_SELECT = {
  id: true,
  workspaceId: true,
  title: true,
  message: true,
  status: true,
  proposerKind: true,
  proposedById: true,
  proposedBy: USER_NAME,
  agentLabel: true,
  workItem: { select: { id: true, title: true, status: true } },
  aiRunId: true,
  revisesId: true,
  attentionItemId: true,
  contentHash: true,
  createdAt: true,
  updatedAt: true,
  submittedAt: true,
  closedAt: true,
  changes: { select: { status: true } },
} satisfies Prisma.ChangesetSelect;

export type ChangesetSummaryRow = Prisma.ChangesetGetPayload<{
  select: typeof CHANGESET_SUMMARY_SELECT;
}>;

export const CHANGESET_DETAIL_SELECT = {
  ...CHANGESET_SUMMARY_SELECT,
  changes: { select: CHANGE_SELECT, orderBy: { position: 'asc' } },
  revisions: { select: { id: true }, orderBy: { createdAt: 'asc' } },
} satisfies Prisma.ChangesetSelect;

export type ChangesetDetailRow = Prisma.ChangesetGetPayload<{
  select: typeof CHANGESET_DETAIL_SELECT;
}>;

const EMPTY_DIFF: ChangesetDiff = {
  blocks: [],
  summary: { added: 0, removed: 0, changed: 0, moved: 0, unchanged: 0 },
  truncated: false,
};

/** Written only through the schema; a row that does not parse was edited by hand. */
function parseDiff(value: Prisma.JsonValue): ChangesetDiff {
  const parsed = changesetDiffSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_DIFF;
}

function countsOf(statuses: readonly { status: PrismaChangeStatus }[]): ChangesetCounts {
  const count = (status: PrismaChangeStatus) =>
    statuses.filter((entry) => entry.status === status).length;
  return {
    total: statuses.length,
    pending: count('PENDING'),
    applied: count('APPLIED'),
    rejected: count('REJECTED'),
    stale: count('STALE'),
  };
}

export function toChangesetSummary(row: ChangesetSummaryRow): ChangesetSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    message: row.message,
    status: STATUS_FROM_PRISMA[row.status],
    proposedBy: {
      kind: PARTICIPANT_FROM_PRISMA[row.proposerKind],
      userId: row.proposedById,
      name: row.proposedBy?.name ?? null,
    },
    agentLabel: row.agentLabel,
    workItem:
      row.workItem === null
        ? null
        : {
            id: row.workItem.id,
            title: row.workItem.title,
            status: WORK_ITEM_STATUS_FROM_PRISMA[row.workItem.status],
          },
    runId: row.aiRunId,
    revisesId: row.revisesId,
    attentionItemId: row.attentionItemId,
    counts: countsOf(row.changes),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

/** The page state a reader sees beside a change: its title now and its revision now. */
export interface PageNow {
  title: string;
  revision: string | null;
}

/** Title and revision of every page the changes name, in one query. */
export async function pagesNow(
  prisma: PrismaClient,
  workspaceId: string,
  documentIds: readonly (string | null)[],
): Promise<Map<string, PageNow>> {
  const ids = [...new Set(documentIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.document.findMany({
    where: { id: { in: ids }, workspaceId },
    select: { id: true, title: true, content: { select: { yjsUpdatedAt: true } } },
  });
  return new Map(
    rows.map((row) => [
      row.id,
      { title: row.title, revision: row.content?.yjsUpdatedAt.toISOString() ?? null },
    ]),
  );
}

function stringField(request: Prisma.JsonValue, key: string): string | null {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return null;
  const value = (request as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/** Where a change lands, in words a reader can place: a block, a heading, nothing. */
function targetOf(row: ChangeRow): string | null {
  if (row.kind === 'BLOCK') return stringField(row.request, 'blockId');
  if (row.kind === 'SECTION') return stringField(row.request, 'heading');
  return null;
}

/** True when a pending change still fits its page: a new page always, a page at the expected revision. */
function isApplicable(row: ChangeRow, page: PageNow | undefined): boolean {
  if (row.status !== 'PENDING') return false;
  if (row.kind === 'CREATE') return true;
  const expected = row.expectedRevision?.toISOString() ?? null;
  return page !== undefined && expected !== null && page.revision === expected;
}

function decidedByOf(row: ChangeRow): ChangesetChange['decidedBy'] {
  if (row.decidedAt === null || row.decidedByKind === null) return null;
  return {
    kind: PARTICIPANT_FROM_PRISMA[row.decidedByKind],
    userId: row.decidedById,
    name: row.decidedBy?.name ?? null,
  };
}

/** What the change brings and where, read out of the stored request. */
function requestView(row: ChangeRow) {
  return {
    markdown: stringField(row.request, 'markdown') ?? stringField(row.request, 'newText') ?? '',
    oldText: stringField(row.request, 'oldText'),
    target: targetOf(row),
    mode: stringField(row.request, 'mode'),
  };
}

export function toChange(row: ChangeRow, page: PageNow | undefined): ChangesetChange {
  return {
    id: row.id,
    position: row.position,
    kind: KIND_FROM_PRISMA[row.kind],
    documentId: row.documentId,
    title: row.kind === 'CREATE' ? row.title : (page?.title ?? null),
    parentId: row.parentId,
    message: row.message,
    ...requestView(row),
    diff: parseDiff(row.diff),
    status: CHANGE_STATUS_FROM_PRISMA[row.status],
    applicable: isApplicable(row, page),
    baseRevision: row.baseRevision?.toISOString() ?? null,
    expectedRevision: row.expectedRevision?.toISOString() ?? null,
    currentRevision: page?.revision ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedBy: decidedByOf(row),
    decisionNote: row.decisionNote,
    errorCode: row.errorCode,
    snapshotId: row.snapshotId,
    createdDocumentId: row.createdDocumentId,
  };
}

export function toChangesetDetail(
  row: ChangesetDetailRow,
  pages: Map<string, PageNow>,
): ChangesetDetail {
  return {
    ...toChangesetSummary(row),
    changes: row.changes.map((change) =>
      toChange(change, change.documentId === null ? undefined : pages.get(change.documentId)),
    ),
    revisionIds: row.revisions.map((revision) => revision.id),
  };
}
