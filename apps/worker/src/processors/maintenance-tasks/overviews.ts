import { QUEUE_NAMES as QUEUES } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type QueueRegistry } from '@exocortex/queue';

/**
 * Turning a domain event into an overview refresh (issue #53, ADR-028).
 *
 * Sits inside the outbox dispatcher for the same reason automations do: the
 * outbox is the one place every domain event passes exactly once, in order. A
 * second listener would be a second thing to keep correct.
 *
 * Nothing here composes anything. It decides *which page* has derived text that
 * may now be wrong and hands the job to the `document-overview` queue, where the
 * hash comparison decides whether there is really anything to do.
 */

/** Events after which a page's own derived text may be wrong. */
const CONTENT_EVENTS = new Set([
  'document.created',
  'document.updated',
  'document.materialized',
  'document.content.replaced',
  'document.moved',
  'document.restored',
]);

/**
 * Events that change a parent's *list* of children rather than a child's text.
 *
 * These need the parent enqueued directly. A newly created page has no text to
 * digest yet, so its own job would find nothing and cascade nothing, and the
 * overview above it would keep describing a tree that is missing a page.
 */
const STRUCTURE_EVENTS = new Set([
  'document.created',
  'document.moved',
  'document.archived',
  'document.restored',
]);

export interface OverviewMatchContext {
  prisma: PrismaClient;
  queues: QueueRegistry;
  /** Whether overviews are composed in this workspace (`overview.enabled`). */
  enabledFor: (workspaceId: string) => Promise<boolean>;
  /** `overview.debounceSeconds`, resolved for the workspace. */
  debounceSecondsFor: (workspaceId: string) => Promise<number>;
}

export interface OverviewEvent {
  workspaceId: string;
  type: string;
  payload: unknown;
  correlationId: string;
}

/**
 * Queues the refreshes this event makes necessary.
 *
 * Cheap when nothing matches, which is the normal case: one settings read
 * (cached) and one indexed query for the page and its parent. A workspace with
 * no overview pages never gets past the second.
 *
 * A permanently deleted page is the one case this cannot reach: its row is
 * gone, so the parent it hung under is no longer knowable from the event. The
 * hourly `refresh-stale-overviews` sweep is what notices that, and the same
 * sweep is the net under every enqueue lost for any other reason.
 */
export async function scheduleOverviewRefreshes(
  context: OverviewMatchContext,
  event: OverviewEvent,
): Promise<number> {
  if (!CONTENT_EVENTS.has(event.type) && !STRUCTURE_EVENTS.has(event.type)) return 0;

  const documentId = subjectDocumentId(event.payload);
  if (documentId === null) return 0;
  if (!(await context.enabledFor(event.workspaceId))) return 0;

  const row = await context.prisma.document.findFirst({
    where: { id: documentId, workspaceId: event.workspaceId },
    select: {
      id: true,
      parentId: true,
      overviewMode: true,
      archivedAt: true,
      parent: { select: { overviewMode: true } },
    },
  });
  if (row === null) return 0;

  const parentIsOverview = row.parent?.overviewMode === 'AUTO';
  const targets = new Set<string>();
  // The page's own job does both halves: its digest, which the page above
  // quotes, and its composition when it is an overview itself. An archived page
  // is skipped -- it is nobody's child any more as far as an overview is
  // concerned -- but its parent below is not.
  if (row.archivedAt === null && (row.overviewMode === 'AUTO' || parentIsOverview)) {
    targets.add(row.id);
  }
  if (STRUCTURE_EVENTS.has(event.type) && parentIsOverview && row.parentId !== null) {
    targets.add(row.parentId);
  }
  if (targets.size === 0) return 0;

  const windowMs = (await context.debounceSecondsFor(event.workspaceId)) * 1_000;
  for (const target of targets) {
    await context.queues.enqueueDebounced(
      QUEUES.documentOverview,
      {
        correlationId: event.correlationId,
        documentId: target,
        workspaceId: event.workspaceId,
        reason: target === row.id ? 'page_changed' : 'child_changed',
        force: false,
        depth: 0,
      },
      {
        // One window per page, shared with the cascade in the processor: a page
        // whose children all changed at once is recomposed once.
        jobId: `overview-${target}`,
        delayMs: windowMs,
        // Twice the window, so a page somebody keeps typing into is still
        // refreshed instead of being postponed all afternoon.
        maxDelayMs: windowMs * 2,
      },
    );
  }
  return targets.size;
}

function subjectDocumentId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const documentId = (payload as Record<string, unknown>).documentId;
  return typeof documentId === 'string' ? documentId : null;
}
