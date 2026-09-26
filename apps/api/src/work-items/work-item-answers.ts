import { attentionResolutionSchema } from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';

import { KIND_FROM_PRISMA, parseOptions } from '../attention/attention-mapper';
import { parseSubject } from '../attention/attention-subject';

import { type ResumeAnswer } from './work-item-resume-prompt';

/**
 * Answers to checkpoints, as a run that carries the work on is told them
 * (issues #140 and #142).
 *
 * Two paths hand answers to a run: an answer that resumes the paused run in its
 * own conversation, and a new run started from a recorded working state, which
 * is told every decision made since. Both say the same things the same way.
 */

export const ANSWERED_ITEM_SELECT = {
  id: true,
  workspaceId: true,
  kind: true,
  status: true,
  title: true,
  options: true,
  resolution: true,
  action: true,
  subject: true,
  workState: true,
  blocking: true,
  system: true,
  settledBy: { select: { name: true } },
} satisfies Prisma.AttentionItemSelect;

export type AnsweredItem = Prisma.AttentionItemGetPayload<{
  select: typeof ANSWERED_ITEM_SELECT;
}>;

async function subjectTitles(
  prisma: PrismaClient,
  items: readonly AnsweredItem[],
): Promise<Map<string, string>> {
  const ids = items.flatMap(
    (item) => parseSubject(item.subject)?.pages.map((page) => page.documentId) ?? [],
  );
  if (ids.length === 0) return new Map();
  const rows = await prisma.document.findMany({
    where: { id: { in: ids }, workspaceId: items[0]!.workspaceId },
    select: { id: true, title: true },
  });
  return new Map(rows.map((row) => [row.id, row.title]));
}

function answerOf(item: AnsweredItem, titles: ReadonlyMap<string, string>): ResumeAnswer {
  const resolution = attentionResolutionSchema.safeParse(item.resolution);
  const facts = resolution.success ? resolution.data : {};
  const option = parseOptions(item.options).find((entry) => entry.id === facts.optionId);
  return {
    attentionItemId: item.id,
    kind: KIND_FROM_PRISMA[item.kind],
    title: item.title,
    status: item.status === 'OBSOLETE' ? 'obsolete' : 'resolved',
    optionId: facts.optionId ?? null,
    optionLabel: option?.label ?? null,
    note: facts.note ?? null,
    obsoleteReason: facts.reason ?? null,
    answeredBy: item.settledBy?.name ?? null,
    action: item.action,
    // A stale approval hands no revision on: there is nothing it approves.
    subject: item.status === 'OBSOLETE' ? null : parseSubject(item.subject),
    subjectTitles: titles,
  };
}

/** Settled items as the answers a run is handed, oldest first as given. */
export async function toResumeAnswers(
  prisma: PrismaClient,
  items: readonly AnsweredItem[],
): Promise<ResumeAnswer[]> {
  const titles = await subjectTitles(prisma, items);
  return items.map((item) => answerOf(item, titles));
}
