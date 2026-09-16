import { type QUEUE_NAMES, type Settings } from '@exocortex/contracts';
import { type HybridSearchAdapter, Prisma, type PrismaClient } from '@exocortex/database';
import { type JobContext, type QueueRegistry, type RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

type MaintenanceJob = JobContext<typeof QUEUE_NAMES.maintenance>;

/**
 * Everything a maintenance task is allowed to reach for.
 *
 * The tasks used to be twelve branches of one switch, sharing a closure. They
 * are functions now, one per file group, and this is what the closure became:
 * the resolved dependencies plus the three things the job itself carries.
 */
export interface MaintenanceContext {
  prisma: PrismaClient;
  queues: QueueRegistry;
  storage: ObjectStorage;
  search: HybridSearchAdapter;
  bus: RedisEventBus;
  /**
   * The configuration in force, deployment-wide or inside one workspace.
   *
   * A sweep that acts on one workspace at a time has to pass its id (ADR-023),
   * or it will apply somebody else's retention to it. A sweep that genuinely
   * spans the installation calls this with nothing, which is the old behaviour.
   */
  settings: (workspaceId?: string) => Promise<Settings>;
  /** Outbox rows dispatched per run. */
  outboxBatchSize: number;
  /** How long a cover-only upload is kept after it stops being a cover. */
  orphanedCoverGraceMs: number;
  /** Content rows the reference backfill extracts per run. */
  linkBackfillBatchSize: number;
  /** Documents per embedding request inside a backfill run. */
  embeddingBackfillBatchSize: number;
  /** Where the OpenRouter catalogue is read from, for the model route refresh (ADR-032). */
  openRouterBaseUrl: string;
  payload: MaintenanceJob['payload'];
  logger: MaintenanceJob['logger'];
  reportProgress: MaintenanceJob['reportProgress'];
}

/** One scheduled housekeeping job. */
export type MaintenanceTask = (context: MaintenanceContext) => Promise<void>;

/**
 * Every active agent memory area (issue #52, ADR-023).
 *
 * Three nightly sweeps used to read one configured id. They iterate now: the
 * memory is a property of a workspace, so a deployment has as many of them as
 * there are accounts that wanted one, each with its own retention.
 */
export async function memoryWorkspaceIds(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.workspace.findMany({
    where: { isMemory: true, archivedAt: null },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/**
 * True when a write failed because the row it points at is gone. `P2003` is the
 * foreign key violation a delete between reading a candidate and writing its
 * snapshot produces.
 */
export function isMissingDocument(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

/**
 * True when an update found nothing to update. `P2025` is what Prisma reports
 * when the row addressed by `where` no longer exists -- for an outbox row that
 * means its workspace was deleted between the batch being read and the row
 * being marked, which is a race, not a defect.
 */
export function isMissingRow(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}
