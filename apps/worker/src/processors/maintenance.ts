import { EMBEDDING_BATCH_SIZE } from '@exocortex/ai';
import { type QUEUE_NAMES, type Settings } from '@exocortex/contracts';
import { type HybridSearchAdapter, type PrismaClient } from '@exocortex/database';
import { type JobContext, type QueueRegistry, type RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import {
  collectOrphanedCovers,
  pruneAgentJournal,
  pruneAiRunPayloads,
  pruneAutomationRuns,
  pruneInvitations,
  pruneMemories,
  reapProjectBuilds,
  reapRenderJobs,
  reapStaleAiRuns,
} from './maintenance-tasks/cleanup';
import { rematerializeStaleContent } from './maintenance-tasks/content';
import { type MaintenanceTask } from './maintenance-tasks/context';
import { backfillLinks, repairLinks, resolveLinks } from './maintenance-tasks/links';
import { consolidateMemories, decayMemoryFacts } from './maintenance-tasks/memory-facts';
import { dispatchOutbox } from './maintenance-tasks/outbox';
import { refreshStaleOverviews } from './maintenance-tasks/overview-sweep';
import { backfillEmbeddings, vacuumSearchIndex } from './maintenance-tasks/search-index';
import { pruneSnapshots, snapshotActiveDocuments } from './maintenance-tasks/snapshots';

export { pruneSnapshotIds } from './maintenance-tasks/snapshots';

export interface MaintenanceDependencies {
  prisma: PrismaClient;
  queues: QueueRegistry;
  storage: ObjectStorage;
  /**
   * The same adapter the indexing worker writes through, so `backfill-embeddings`
   * produces exactly what ordinary indexing produces -- including the "text has
   * not changed" check that keeps a re-run from paying for the same vector twice.
   */
  search: HybridSearchAdapter;
  /** Publishes `ai.run.failed` for a run `reap-stale-ai-runs` closes out. */
  bus: RedisEventBus;
  /**
   * Same resolver the AI processor uses. `prune-snapshots` and
   * `snapshot-active-documents` also read their tuning from here
   * (`activity.*`, ADR-013) rather than from a constructor option, so an
   * admin can change retention without a redeploy.
   */
  settings: (workspaceId?: string) => Promise<Settings>;
  /** Outbox rows dispatched per run. */
  outboxBatchSize?: number;
  /**
   * How long a cover-only upload is kept after it stops being a cover. The
   * grace period is what makes the sweep safe against a client that uploads
   * first and points the page at the file a moment later.
   */
  orphanedCoverGraceMs?: number;
  /** Content rows the reference backfill extracts per run. */
  linkBackfillBatchSize?: number;
  /** Documents per embedding request inside a backfill run. */
  embeddingBackfillBatchSize?: number;
}

type MaintenanceTaskName = JobContext<typeof QUEUE_NAMES.maintenance>['payload']['task'];

/**
 * Every housekeeping job, by name.
 *
 * A `Record` over the task union rather than a switch, so a task added to the
 * contract without a handler here is a type error rather than something the
 * old exhaustiveness guard had to catch at runtime.
 */
const TASKS: Record<MaintenanceTaskName, MaintenanceTask> = {
  'dispatch-outbox': dispatchOutbox,
  'prune-snapshots': pruneSnapshots,
  'snapshot-active-documents': snapshotActiveDocuments,
  'collect-orphaned-covers': collectOrphanedCovers,
  'vacuum-search-index': vacuumSearchIndex,
  'reap-stale-ai-runs': reapStaleAiRuns,
  'resolve-document-links': resolveLinks,
  'repair-document-links': repairLinks,
  'backfill-document-links': backfillLinks,
  'rematerialize-stale-content': rematerializeStaleContent,
  'refresh-stale-overviews': refreshStaleOverviews,
  'backfill-embeddings': backfillEmbeddings,
  'prune-memories': pruneMemories,
  'prune-invitations': pruneInvitations,
  'consolidate-memories': consolidateMemories,
  'decay-memory-facts': decayMemoryFacts,
  'prune-ai-run-payloads': pruneAiRunPayloads,
  'prune-agent-journal': pruneAgentJournal,
  'prune-automation-runs': pruneAutomationRuns,
  'reap-render-jobs': reapRenderJobs,
  'reap-project-builds': reapProjectBuilds,
};

/**
 * Maintenance processor.
 *
 * Seventeen unrelated sweeps share one queue and one schedule; what they have in
 * common is that nobody is waiting for them. The work itself lives one per
 * function in `maintenance-tasks/`, grouped by what it touches.
 */
export function createMaintenanceProcessor(dependencies: MaintenanceDependencies) {
  return async ({
    payload,
    logger,
    reportProgress,
  }: JobContext<typeof QUEUE_NAMES.maintenance>): Promise<void> => {
    await TASKS[payload.task]({
      prisma: dependencies.prisma,
      queues: dependencies.queues,
      storage: dependencies.storage,
      search: dependencies.search,
      bus: dependencies.bus,
      settings: dependencies.settings,
      outboxBatchSize: dependencies.outboxBatchSize ?? 100,
      orphanedCoverGraceMs: dependencies.orphanedCoverGraceMs ?? 60 * 60 * 1000,
      linkBackfillBatchSize: dependencies.linkBackfillBatchSize ?? 50,
      embeddingBackfillBatchSize: dependencies.embeddingBackfillBatchSize ?? EMBEDDING_BATCH_SIZE,
      payload,
      logger,
      reportProgress,
    });
  };
}
