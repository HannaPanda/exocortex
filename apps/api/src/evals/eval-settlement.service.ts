import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { type ApiEnv } from '@exocortex/config';
import { type EvalAttemptArtifacts, type EvalOutcome } from '@exocortex/contracts';
import { type AiRun, type Prisma, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { RedisEventBus } from '@exocortex/queue';

import { settleOne } from '../attention/attention-sync';
import { ChangesetsService } from '../changesets/changesets.service';
import { AppError } from '../common/app-error';
import { runWithRequestContext } from '../common/correlation';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';
import { RealtimeService } from '../realtime/realtime.service';
import { type WorkItemActor } from '../work-items/work-item-actor';

import { buildMetrics, type EvalFacts, evaluateAssertions, outcomeOf } from './eval-assertions';
import {
  attemptDefinition,
  EVAL_ATTEMPT_SELECT,
  type EvalAttemptRow,
  OUTCOME_TO_PRISMA,
  storedManual,
} from './eval-mapper';
import { EvalSandboxService, type SandboxPage } from './eval-sandbox.service';

/** How often open attempts are looked at, whatever the bus said. */
const SWEEP_INTERVAL_MS = 30_000;
/** An attempt that claimed its slot and never got a run this long after is given up. */
const LAUNCH_LOST_MS = 10 * 60_000;
const OPEN_RUN_STATUSES = new Set(['PENDING', 'RUNNING']);
const SWEEP_BATCH = 50;

type Launcher = (attemptId: string) => Promise<void>;

/**
 * Ending an eval attempt (issue #146, ADR-074): freeze what its run did,
 * decide its checks, and take back everything it was allowed to leave behind.
 *
 * Three things ask for it, because each alone can miss: the run's own
 * terminal event on the bus, a sweep every half minute, and the cancel route.
 * Settling is idempotent: the outcome is written by a conditional update
 * that only one caller can win, and only the winner cleans up, so a second
 * caller that read the sandbox while the first was deleting it writes
 * nothing.
 */
@Injectable()
export class EvalSettlementService implements OnModuleInit, OnModuleDestroy {
  private readonly bus: RedisEventBus;
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();
  private launcher: Launcher | null = null;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(API_ENV) env: ApiEnv,
    private readonly sandbox: EvalSandboxService,
    private readonly changesets: ChangesetsService,
    private readonly realtime: RealtimeService,
  ) {
    this.bus = new RedisEventBus({ redisUrl: env.REDIS_URL, logger });
  }

  /** The run service starts attempts; it registers here so the sweep can start lost ones. */
  onLaunch(launcher: Launcher): void {
    this.launcher = launcher;
  }

  async onModuleInit(): Promise<void> {
    await this.bus.subscribe(async (event) => {
      if (event.type !== 'ai.run.completed' && event.type !== 'ai.run.failed') return;
      const run = await this.prisma.aiRun.findUnique({
        where: { id: event.payload.runId },
        select: { evalAttemptId: true },
      });
      if (run?.evalAttemptId != null) await this.settleQuietly(run.evalAttemptId);
    });
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.bus.close();
  }

  /** Every open attempt, looked at once: settled when its run is over, started when it was lost. */
  async sweep(): Promise<void> {
    try {
      const open = await this.prisma.evalAttempt.findMany({
        where: { status: { in: ['QUEUED', 'RUNNING'] } },
        select: { id: true, status: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: SWEEP_BATCH,
      });
      for (const attempt of open) {
        if (attempt.status === 'RUNNING') await this.settleQuietly(attempt.id);
        else if (Date.now() - attempt.createdAt.getTime() > SWEEP_INTERVAL_MS) {
          await this.launcher?.(attempt.id);
        }
      }
    } catch (error) {
      this.logger.warn('Eval sweep failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Settles when the attempt's run is over; never throws, because nobody is waiting on it. */
  async settleQuietly(attemptId: string, options: { cancelled?: boolean } = {}): Promise<void> {
    try {
      await this.settle(attemptId, options);
    } catch (error) {
      this.logger.error('Settling an eval attempt failed', error, { attemptId });
    }
  }

  /**
   * Settles the attempt if its run is over (or it was cancelled). Returns
   * whether this call settled it.
   */
  async settle(attemptId: string, options: { cancelled?: boolean } = {}): Promise<boolean> {
    if (this.inFlight.has(attemptId)) return false;
    this.inFlight.add(attemptId);
    try {
      return await runWithRequestContext({ correlationId: `eval-${attemptId}` }, () =>
        this.settleNow(attemptId, options.cancelled === true),
      );
    } finally {
      this.inFlight.delete(attemptId);
    }
  }

  /**
   * Ends an attempt that never got as far as a run: the sandbox could not be
   * built, the model was refused. `error` says nothing about the model.
   */
  async failLaunch(attemptId: string, error: unknown): Promise<void> {
    const errorCode = error instanceof AppError ? error.code : 'eval_launch_failed';
    this.logger.warn('An eval attempt could not be started', {
      attemptId,
      errorCode,
      reason: error instanceof Error ? error.message : String(error),
    });
    const attempt = await this.prisma.evalAttempt.findUnique({
      where: { id: attemptId },
      select: EVAL_ATTEMPT_SELECT,
    });
    if (attempt === null) return;
    const won = await this.prisma.evalAttempt.updateMany({
      where: { id: attemptId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'FINISHED',
        outcome: 'ERROR',
        errorCode: errorCode.slice(0, 100),
        finishedAt: new Date(),
      },
    });
    if (won.count === 1) await this.cleanUp(attempt, { runCreatorId: null });
  }

  private async settleNow(attemptId: string, cancelled: boolean): Promise<boolean> {
    const attempt = await this.prisma.evalAttempt.findUnique({
      where: { id: attemptId },
      select: EVAL_ATTEMPT_SELECT,
    });
    if (attempt === null || attempt.status === 'FINISHED' || attempt.status === 'CANCELLED') {
      return false;
    }
    if (attempt.status === 'QUEUED') {
      if (!cancelled) return false;
      const won = await this.prisma.evalAttempt.updateMany({
        where: { id: attemptId, status: 'QUEUED' },
        data: { status: 'CANCELLED', finishedAt: new Date() },
      });
      if (won.count === 1) await this.announce(attempt);
      return won.count === 1;
    }

    // The run is found by the id it carries rather than the attempt's, which
    // is written a moment after the run exists and may not be there yet.
    const run = await this.prisma.aiRun.findFirst({ where: { evalAttemptId: attempt.id } });
    if (run === null) {
      const lost =
        attempt.startedAt !== null && Date.now() - attempt.startedAt.getTime() > LAUNCH_LOST_MS;
      if (cancelled || lost) {
        await this.failLaunch(attempt.id, new AppError('eval_launch_failed', 'No run was made'));
        return true;
      }
      return false;
    }
    if (OPEN_RUN_STATUSES.has(run.status)) {
      if (!cancelled) return false;
      await this.prisma.aiRun.updateMany({
        where: { id: run.id, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'CANCELLED', cancelledAt: new Date(), finishedAt: new Date() },
      });
    }

    const finished = await this.prisma.aiRun.findUniqueOrThrow({ where: { id: run.id } });
    const { facts, artifacts, openAttention } = await this.gather(attempt, finished);
    const definition = attemptDefinition(attempt);
    const assertions = evaluateAssertions(definition, facts, storedManual(attempt.reviewManual));
    const outcome: EvalOutcome | null = cancelled ? null : outcomeOf(facts.runStatus, assertions);

    const won = await this.prisma.evalAttempt.updateMany({
      where: { id: attempt.id, status: 'RUNNING' },
      data: {
        status: cancelled ? 'CANCELLED' : 'FINISHED',
        outcome: outcome === null ? null : OUTCOME_TO_PRISMA[outcome],
        errorCode: finished.errorCode,
        aiRunId: finished.id,
        metrics: facts.metrics as unknown as Prisma.InputJsonObject,
        assertions: assertions as unknown as Prisma.InputJsonArray,
        artifacts: artifacts as unknown as Prisma.InputJsonObject,
        answer: finished.resultText,
        finishedAt: new Date(),
      },
    });
    if (won.count !== 1) return false;

    await this.cleanUp(attempt, { runCreatorId: finished.createdById, openAttention });
    return true;
  }

  /** What the attempt left behind, read before anything is taken away. */
  private async gather(
    attempt: EvalAttemptRow,
    run: AiRun,
  ): Promise<{ facts: EvalFacts; artifacts: EvalAttemptArtifacts; openAttention: string[] }> {
    const [events, attention, changesets] = await Promise.all([
      this.prisma.aiRunEvent.findMany({
        where: { runId: run.id },
        orderBy: { sequence: 'asc' },
        select: { sequence: true, kind: true, at: true, durationMs: true, data: true },
      }),
      this.prisma.attentionItem.findMany({
        where: { aiRunId: run.id },
        select: { id: true, status: true },
      }),
      this.prisma.changeset.findMany({
        where: { aiRunId: run.id },
        select: {
          id: true,
          title: true,
          submittedAt: true,
          closedAt: true,
          _count: { select: { changes: true } },
        },
      }),
    ]);
    const proposedChanges = changesets.reduce((total, row) => total + row._count.changes, 0);
    const metrics = buildMetrics({
      run,
      events,
      humanCheckpoints: attention.length,
      proposedChanges,
    });

    const pages = sandboxPages(attempt.sandboxPages);
    const reading =
      attempt.sandboxDocumentId === null || pages === null
        ? null
        : await this.sandbox.read({ rootId: attempt.sandboxDocumentId, pages });

    const facts: EvalFacts = {
      runStatus: run.status.toLowerCase(),
      answer: run.resultText ?? '',
      metrics,
      pages: reading?.pages ?? {},
      changedPages: reading?.changedPages ?? 0,
      createdPages: reading?.createdCount ?? 0,
    };
    const artifacts: EvalAttemptArtifacts = {
      pages: reading?.pages ?? {},
      createdPages: reading?.createdPages ?? [],
      changesets: changesets.map((row) => ({
        id: row.id,
        title: row.title,
        changes: row._count.changes,
        closedAs:
          row.closedAt !== null
            ? 'already_closed'
            : row.submittedAt === null
              ? 'discarded'
              : 'rejected',
      })),
      truncated: reading?.truncated ?? false,
    };
    return {
      facts,
      artifacts,
      openAttention: attention.filter((item) => item.status === 'OPEN').map((item) => item.id),
    };
  }

  /**
   * Takes back what the attempt was allowed to leave: its proposals, its
   * questions, its sandbox, its conversation in the chat list. Each step is
   * on its own, because a step that fails must not keep the others from
   * happening.
   */
  private async cleanUp(
    attempt: EvalAttemptRow,
    input: { runCreatorId: string | null; openAttention?: string[] },
  ): Promise<void> {
    const owner =
      input.runCreatorId ??
      (
        await this.prisma.evalRun.findUnique({
          where: { id: attempt.evalRunId },
          select: { createdById: true },
        })
      )?.createdById ??
      null;
    const correlationId = `eval-${attempt.id}`;
    const actor: WorkItemActor | null =
      owner === null ? null : { kind: 'human', userId: owner, agentLabel: null };

    const steps: [string, () => Promise<void>][] = [
      ['proposals', () => this.closeProposals(attempt, actor, correlationId)],
      ['questions', () => this.withdrawQuestions(input.openAttention ?? [], actor)],
      [
        'sandbox',
        async () => {
          if (attempt.sandboxDocumentId !== null && owner !== null) {
            await this.sandbox.destroy({
              documentId: attempt.sandboxDocumentId,
              userId: owner,
              correlationId,
            });
          }
        },
      ],
      [
        'conversation',
        async () => {
          if (attempt.conversationId !== null) {
            await this.prisma.aiConversation.updateMany({
              where: { id: attempt.conversationId, archivedAt: null },
              data: { archivedAt: new Date() },
            });
          }
        },
      ],
      ['container', () => this.closeContainer(attempt.evalRunId, owner, correlationId)],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (error) {
        this.logger.warn('An eval clean-up step failed', {
          attemptId: attempt.id,
          step: name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.announce(attempt);
  }

  /** Drafts are deleted, handed-in proposals rejected; neither is ever applied. */
  private async closeProposals(
    attempt: EvalAttemptRow,
    actor: WorkItemActor | null,
    correlationId: string,
  ): Promise<void> {
    const run = await this.prisma.aiRun.findFirst({
      where: { evalAttemptId: attempt.id },
      select: { id: true },
    });
    if (run === null) return;
    const open = await this.prisma.changeset.findMany({
      where: { aiRunId: run.id, closedAt: null },
      select: { id: true, submittedAt: true },
    });
    for (const changeset of open) {
      if (changeset.submittedAt === null) {
        await this.prisma.changeset.delete({ where: { id: changeset.id } });
      } else if (actor !== null) {
        await this.changesets.reject({
          changesetId: changeset.id,
          actor,
          request: {
            note: 'Eval-Versuch beendet: ein Vorschlag aus einem Eval wird nie übernommen.',
          },
          correlationId,
        });
      }
    }
  }

  private async withdrawQuestions(ids: string[], actor: WorkItemActor | null): Promise<void> {
    if (actor === null) return;
    for (const id of ids) {
      await settleOne(this.prisma, {
        attentionItemId: id,
        status: 'OBSOLETE',
        actor,
        resolution: { reason: 'eval_attempt_finished' },
      });
    }
  }

  /** The run's container page goes with its last open attempt. */
  private async closeContainer(
    evalRunId: string,
    owner: string | null,
    correlationId: string,
  ): Promise<void> {
    const run = await this.prisma.evalRun.findUnique({
      where: { id: evalRunId },
      select: {
        sandboxDocumentId: true,
        _count: { select: { attempts: { where: { status: { in: ['QUEUED', 'RUNNING'] } } } } },
      },
    });
    if (run?.sandboxDocumentId == null || run._count.attempts > 0 || owner === null) return;
    await this.sandbox.destroy({ documentId: run.sandboxDocumentId, userId: owner, correlationId });
  }

  private async announce(attempt: Pick<EvalAttemptRow, 'evalRunId' | 'workspaceId' | 'caseId'>) {
    await this.realtime.emit('eval.changed', attempt.workspaceId, `eval-${attempt.evalRunId}`, {
      evalCaseId: attempt.caseId,
      evalRunId: attempt.evalRunId,
      action: 'attempt_settled',
    });
  }
}

/** The stored key-to-page map of a fixture attempt, or null when it has none. */
function sandboxPages(value: unknown): Record<string, SandboxPage> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const pages: Record<string, SandboxPage> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, baseline } = entry as { id?: unknown; baseline?: unknown };
    if (typeof id === 'string' && typeof baseline === 'string') pages[key] = { id, baseline };
  }
  return pages;
}
