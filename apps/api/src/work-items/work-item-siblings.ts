import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';

import { writesDirectly } from './work-item-delegation-rules';

/**
 * Children run side by side unless two of them would write at once (issue
 * #144, ADR-072).
 *
 * A child held to `read_only` or `propose` changes no page, so any number of
 * them may run together. A child that writes directly waits while another
 * directly writing child of the same parent has a run pending or running;
 * the refusal names the sibling, so the parent can wait for it or hand the
 * part on as a proposal instead.
 */
export async function assertSiblingsAllowRun(
  prisma: PrismaClient,
  item: {
    id: string;
    parentId: string | null;
    writeMode: 'READ_ONLY' | 'PROPOSE' | 'DIRECT' | null;
  },
): Promise<void> {
  if (item.parentId === null || !writesDirectly(item.writeMode)) return;
  const busy = await prisma.workItem.findFirst({
    where: {
      parentId: item.parentId,
      id: { not: item.id },
      OR: [{ writeMode: null }, { writeMode: 'DIRECT' }],
      runs: { some: { status: { in: ['PENDING', 'RUNNING'] } } },
    },
    select: { id: true, title: true },
  });
  if (busy !== null) {
    throw new AppError(
      'work_item_sibling_writing',
      `A sibling that writes directly is running ("${busy.title}", ${busy.id}); wait for it or hand this part on in propose mode`,
    );
  }
}

/**
 * A parent is done when its parts are (issue #144): `done` is refused while a
 * child is still open or waiting for review. Cancelling and failing stay
 * possible, because ending the whole is a decision about the parts too.
 */
export async function assertChildrenClosed(
  prisma: PrismaClient,
  workItemId: string,
): Promise<void> {
  const open = await prisma.workItem.count({ where: { parentId: workItemId, closedAt: null } });
  if (open > 0) {
    throw new AppError(
      'work_item_children_open',
      `${open} child item(s) are still open; close or cancel them before this one is done`,
    );
  }
}
