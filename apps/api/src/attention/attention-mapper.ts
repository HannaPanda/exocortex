import {
  type AttentionItem,
  type AttentionKind,
  type AttentionNoteMode,
  attentionOptionSchema,
  attentionResolutionSchema,
  type AttentionStatus,
  type AttentionSubjectPage,
} from '@exocortex/contracts';
import {
  type AttentionKind as PrismaKind,
  type AttentionNoteMode as PrismaNoteMode,
  type AttentionStatus as PrismaStatus,
  type Prisma,
} from '@exocortex/database';

import {
  PARTICIPANT_FROM_PRISMA,
  PRIORITY_FROM_PRISMA,
  STATUS_FROM_PRISMA,
} from '../work-items/work-item-mapper';

/**
 * Between the rows and the wire (issue #139). Total maps in both directions,
 * as for work items, so a member added on one side only is a compile error.
 */

export const KIND_TO_PRISMA: Record<AttentionKind, PrismaKind> = {
  decision: 'DECISION',
  approval: 'APPROVAL',
  review: 'REVIEW',
  blocked: 'BLOCKED',
  budget: 'BUDGET',
  run_failed: 'RUN_FAILED',
  conflict: 'CONFLICT',
  information: 'INFORMATION',
};
export const KIND_FROM_PRISMA: Record<PrismaKind, AttentionKind> = {
  DECISION: 'decision',
  APPROVAL: 'approval',
  REVIEW: 'review',
  BLOCKED: 'blocked',
  BUDGET: 'budget',
  RUN_FAILED: 'run_failed',
  CONFLICT: 'conflict',
  INFORMATION: 'information',
};

export const STATUS_FROM: Record<PrismaStatus, AttentionStatus> = {
  OPEN: 'open',
  RESOLVED: 'resolved',
  OBSOLETE: 'obsolete',
};

export const NOTE_MODE_TO_PRISMA: Record<AttentionNoteMode, PrismaNoteMode> = {
  none: 'NONE',
  optional: 'OPTIONAL',
  required: 'REQUIRED',
};
const NOTE_MODE_FROM: Record<PrismaNoteMode, AttentionNoteMode> = {
  NONE: 'none',
  OPTIONAL: 'optional',
  REQUIRED: 'required',
};

const USER_NAME = { select: { id: true, name: true } } as const;

export const ATTENTION_SELECT = {
  id: true,
  workspaceId: true,
  workspace: { select: { name: true } },
  kind: true,
  status: true,
  title: true,
  reason: true,
  urgency: true,
  recipientId: true,
  raisedByKind: true,
  raisedById: true,
  raisedBy: USER_NAME,
  agentLabel: true,
  system: true,
  workItem: { select: { id: true, title: true, status: true } },
  aiRun: { select: { id: true, conversationId: true, errorCode: true } },
  options: true,
  noteMode: true,
  blocking: true,
  context: true,
  action: true,
  workState: true,
  subject: true,
  settledAt: true,
  settledByKind: true,
  settledById: true,
  settledBy: USER_NAME,
  resolution: true,
  createdAt: true,
} satisfies Prisma.AttentionItemSelect;

export type AttentionRow = Prisma.AttentionItemGetPayload<{ select: typeof ATTENTION_SELECT }>;

/** Written only through the schema; a row that does not parse was edited by hand. */
export function parseOptions(value: Prisma.JsonValue): AttentionItem['options'] {
  const parsed = attentionOptionSchema.array().safeParse(value);
  return parsed.success ? parsed.data : [];
}

function parseResolution(value: Prisma.JsonValue | null): AttentionItem['resolution'] {
  if (value === null) return null;
  const parsed = attentionResolutionSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

/**
 * `subject` is the item's subject pages as the reader sees them, from
 * `subjectPagesFor`; an item bound to pages whose lookup the caller skipped
 * reads as bound to none.
 */
export function toAttentionItem(
  row: AttentionRow,
  subject: AttentionSubjectPage[] | null = null,
  changeset: AttentionItem['changeset'] = null,
): AttentionItem {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: row.workspace.name,
    kind: KIND_FROM_PRISMA[row.kind],
    status: STATUS_FROM[row.status],
    title: row.title,
    reason: row.reason,
    urgency: PRIORITY_FROM_PRISMA[row.urgency],
    recipientId: row.recipientId,
    raisedBy: {
      kind: PARTICIPANT_FROM_PRISMA[row.raisedByKind],
      userId: row.raisedById,
      name: row.raisedBy?.name ?? null,
    },
    agentLabel: row.agentLabel,
    system: row.system,
    workItem:
      row.workItem === null
        ? null
        : {
            id: row.workItem.id,
            title: row.workItem.title,
            status: STATUS_FROM_PRISMA[row.workItem.status],
          },
    run: row.aiRun,
    options: parseOptions(row.options),
    noteMode: NOTE_MODE_FROM[row.noteMode],
    blocking: row.blocking,
    context: row.context,
    action: row.action,
    workState: row.workState,
    subject,
    changeset,
    settledAt: row.settledAt?.toISOString() ?? null,
    settledBy:
      row.settledByKind === null
        ? null
        : {
            kind: PARTICIPANT_FROM_PRISMA[row.settledByKind],
            userId: row.settledById,
            name: row.settledBy?.name ?? null,
          },
    resolution: parseResolution(row.resolution),
    createdAt: row.createdAt.toISOString(),
  };
}
