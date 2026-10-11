import { AI_RUN_EVENT_LIMIT, type AiRunEventData } from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

/**
 * Writes a run's timeline while it happens (issue #145, ADR-073).
 *
 * One row per step, numbered in the order they were recorded. The inspector
 * is a view on the run, never part of it: a write that fails is logged and
 * forgotten, because a run that answered correctly must not fail over the
 * bookkeeping of how it did. Writes are chained rather than awaited by the
 * caller, so a slow insert never holds up a turn, and `flush` waits for the
 * chain before the run writes its terminal status.
 *
 * The data is checked against the contract on the way in by the type system
 * alone; what goes in is ids, counts, sizes and outcomes, never content.
 */
export class RunTimeline {
  private sequence = 0;
  private pending: Promise<void> = Promise.resolve();
  private capped = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly runId: string,
    private readonly logger: Logger,
  ) {}

  record(event: AiRunEventData, timing: { at?: Date; durationMs?: number } = {}): void {
    if (this.capped) return;
    if (this.sequence >= AI_RUN_EVENT_LIMIT) {
      this.capped = true;
      this.logger.info('Run timeline reached its event limit; later steps are not recorded', {
        runId: this.runId,
        limit: AI_RUN_EVENT_LIMIT,
      });
      return;
    }
    this.sequence += 1;
    const sequence = this.sequence;
    const at = timing.at ?? new Date();
    this.pending = this.pending.then(async () => {
      try {
        await this.prisma.aiRunEvent.create({
          data: {
            runId: this.runId,
            sequence,
            kind: event.kind,
            at,
            durationMs: timing.durationMs === undefined ? null : Math.round(timing.durationMs),
            data: event.data as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        this.logger.warn('Could not record a step of the run timeline', {
          runId: this.runId,
          kind: event.kind,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /** Measures `work` and records what `describe` makes of its result, started when it started. */
  async timed<T>(
    work: () => Promise<T>,
    describe: (result: T) => AiRunEventData | null,
  ): Promise<T> {
    const at = new Date();
    const started = performance.now();
    const result = await work();
    const event = describe(result);
    if (event !== null) this.record(event, { at, durationMs: performance.now() - started });
    return result;
  }

  /** Waits until every recorded step is written (or has failed to be). */
  async flush(): Promise<void> {
    await this.pending;
  }
}
