import {
  aiAutoFillsFor,
  type AiAutoFillTrigger,
  QUEUE_NAMES as QUEUES,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type QueueRegistry } from '@exocortex/queue';

/**
 * Turning a change to a database row into an automatic AI fill (issue #237,
 * ADR-099).
 *
 * Sits inside the outbox dispatcher for the reason everything there does: the
 * outbox is the one place a change passes exactly once. A column switched to
 * fill itself is a property of the column, not an automation rule (the ADR
 * says why), so this does not go through `fireMatchingAutomations`.
 *
 * Nothing here decides which cells are filled. It notices that a row of a
 * database with a self-filling column was created or changed, and queues one
 * debounced `auto` job for the row; the worker asks the API to start a batch
 * per column, as the column's instruction author and in `replace_ai`, so a
 * person's value is never touched.
 *
 * A value write is deliberately not a trigger: the batch's own writes would
 * wake it again.
 */

const TRIGGERS: Readonly<Record<string, AiAutoFillTrigger>> = {
  'document.created': 'created',
  // A title is part of what the model reads, so a new one is a change too.
  'document.updated': 'changed',
  'document.materialized': 'changed',
  'document.content.replaced': 'changed',
};

/**
 * One window per row. Long enough that somebody typing into a new row is
 * filled once they paused, short enough to feel like "it filled itself";
 * capped so a page edited all afternoon is still filled now and then rather
 * than postponed for ever.
 */
export const AUTO_FILL_DEBOUNCE_MS = 30_000;
export const AUTO_FILL_MAX_DELAY_MS = 180_000;

export interface AiAutoFillContext {
  prisma: PrismaClient;
  queues: QueueRegistry;
  /** Whether the AI may run in this workspace at all (`ai.enabled`). */
  enabledFor: (workspaceId: string) => Promise<boolean>;
}

export interface AiAutoFillEvent {
  workspaceId: string;
  type: string;
  payload: unknown;
  correlationId: string;
}

/**
 * Queues the automatic fill this event calls for, and answers whether it did.
 *
 * Cheap when nothing matches, which is the normal case: one indexed read for
 * the page, its parent's type and the parent's self-filling columns. A page
 * that is no database row, or a database with no such column, stops there.
 */
export async function scheduleAiAutoFills(
  context: AiAutoFillContext,
  event: AiAutoFillEvent,
): Promise<boolean> {
  const trigger = TRIGGERS[event.type];
  if (trigger === undefined) return false;
  const rowId = subjectDocumentId(event.payload);
  if (rowId === null) return false;

  const row = await context.prisma.document.findFirst({
    where: { id: rowId, workspaceId: event.workspaceId, type: 'PAGE', archivedAt: null },
    select: {
      parentId: true,
      parent: {
        select: {
          type: true,
          databaseProperties: {
            where: { ai: { autoFill: { in: columnValuesFor(trigger) } } },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  });
  if (row?.parentId === null || row?.parentId === undefined) return false;
  if (row.parent?.type !== 'COLLECTION' || row.parent.databaseProperties.length === 0) return false;
  if (!(await context.enabledFor(event.workspaceId))) return false;

  // A row created and then typed into inside one window is still a new row:
  // the latest payload wins in a debounced job, so `created` is carried over
  // rather than replaced, or a column filling only new rows would miss it.
  const jobId = `ai-fill-auto-${rowId}`;
  const waiting = await context.queues.getQueue(QUEUES.databaseAiFill).getJob(jobId);
  const carried =
    waiting !== undefined &&
    waiting.data.kind === 'auto' &&
    waiting.data.trigger === 'created' &&
    (await waiting.isDelayed());

  await context.queues.enqueueDebounced(
    QUEUES.databaseAiFill,
    {
      kind: 'auto',
      correlationId: event.correlationId,
      workspaceId: event.workspaceId,
      databaseId: row.parentId,
      rowId,
      trigger: carried ? 'created' : trigger,
    },
    { jobId, delayMs: AUTO_FILL_DEBOUNCE_MS, maxDelayMs: AUTO_FILL_MAX_DELAY_MS },
  );
  return true;
}

/** The stored `autoFill` values that answer a trigger, as the column holds them. */
export function columnValuesFor(trigger: AiAutoFillTrigger): ('ON_CREATE' | 'ON_CHANGE')[] {
  return aiAutoFillsFor(trigger).map((value) =>
    value === 'on_create' ? 'ON_CREATE' : 'ON_CHANGE',
  );
}

function subjectDocumentId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const documentId = (payload as Record<string, unknown>).documentId;
  return typeof documentId === 'string' ? documentId : null;
}
