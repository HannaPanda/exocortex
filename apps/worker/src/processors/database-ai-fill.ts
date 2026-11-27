import { AiCancelledError, type AiProvider, AiProviderError } from '@exocortex/ai';
import {
  AI_RUN_HEARTBEAT_INTERVAL_MS,
  type AiFillCellErrorCode,
  type AiFillCellResultRequest,
  aiFillCellResultResponseSchema,
  type AiFillMaterial,
  aiFillMaterialSchema,
  type AiRunStatus,
  type AiUsage,
  parseAiFillAnswerText,
  type QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type ExocortexApiClient, ExocortexApiError } from '@exocortex/mcp-tools';
import { type JobHandler, type RedisEventBus } from '@exocortex/queue';

import { type ResolvedAiKey, WorkspaceKeyUnreadableError } from '../ai-key';

import { estimateCostMicroUsd } from './ai-run/completion';
import { keyRefusalReason, ownKeyPays } from './ai-run/provider-refusal';
import { buildAiFillPrompt } from './database-ai-fill-prompt';

/** Cells asked at the same time. Small: a batch is not meant to race a chat for the provider. */
const CELL_CONCURRENCY = 3;
/** Failed model calls in a row after which the batch stops rather than paying for more. */
const MAX_CONSECUTIVE_MODEL_FAILURES = 3;
/** An answer is one value; anything longer is the model ignoring the format. */
const MAX_OUTPUT_TOKENS = 2_048;
/** Leaves the reaper's deadline (`ai.maxRunMs` + 30 s) to a batch that ends on time. */
const DEADLINE_MARGIN_MS = 10_000;

export interface DatabaseAiFillDependencies {
  prisma: PrismaClient;
  bus: RedisEventBus;
  settings: (workspaceId?: string) => Promise<Settings>;
  /** The same resolution an AI run uses, so the same key pays (ADR-090, ADR-091). */
  providerFor: (
    workspaceId: string,
    providerId?: string,
  ) => Promise<{ provider: AiProvider; key: ResolvedAiKey; openRouter?: AiProvider }>;
  /** A client for the person who started the batch, its token carrying the batch's id. */
  runApiClientFor: ((userId: string, runId: string) => ExocortexApiClient) | null;
}

/** Why a batch stopped before its last cell, as the cells left over record it. */
type StopReason = Extract<
  AiFillCellErrorCode,
  'key_refused' | 'model_failed' | 'budget_exceeded' | 'timed_out' | 'run_ended'
>;

/**
 * Works through one AI fill of a database column (issue #237, ADR-099).
 *
 * The API decided which cells the batch holds; this asks the model once per
 * cell and hands every answer back to the API, which checks it against the
 * column and the cell as they are by then and writes it as the person who
 * started the batch. Nothing here touches a value: the worker reaches the
 * domain through REST (ADR-014).
 *
 * The batch is an `ai_run` of kind FILL, so it is paid with the workspace's
 * key, watched by the reaper through its heartbeat and counted in the usage
 * report like any run. Cancelling it in the API is seen within one heartbeat.
 */
export function createDatabaseAiFillProcessor(
  dependencies: DatabaseAiFillDependencies,
): JobHandler<typeof QUEUE_NAMES.databaseAiFill> {
  return async ({ payload, logger }) => {
    if (payload.kind !== 'run') {
      // The column-driven trigger arrives in a later stage of #237; a job of
      // that kind enqueued by a newer build is dropped, not failed.
      logger.info('AI fill trigger skipped: not handled by this build', { kind: payload.kind });
      return { outcome: 'skipped' };
    }
    const run = await loadBatch(dependencies.prisma, payload.runId);
    if (run === null) {
      logger.info('AI fill skipped: the batch is gone or no longer waiting', {
        runId: payload.runId,
      });
      return { outcome: 'skipped' };
    }
    const batch = new FillBatch(dependencies, run, logger, payload.correlationId);
    return { outcome: await batch.run() };
  };
}

type BatchRow = NonNullable<Awaited<ReturnType<typeof loadBatch>>>;

async function loadBatch(prisma: PrismaClient, runId: string) {
  const run = await prisma.aiRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      kind: true,
      workspaceId: true,
      createdById: true,
      provider: true,
      model: true,
      aiFill: { select: { databaseId: true } },
    },
  });
  if (run === null || run.kind !== 'FILL' || run.aiFill === null || run.status !== 'PENDING') {
    return null;
  }
  return { ...run, databaseId: run.aiFill.databaseId };
}

type Resolved = Awaited<ReturnType<DatabaseAiFillDependencies['providerFor']>>;

/** One batch from PENDING to its end. */
class FillBatch {
  private readonly prisma: PrismaClient;
  private stop: StopReason | null = null;
  private cancelled = false;
  private consecutiveFailures = 0;
  private readonly abort = new AbortController();

  constructor(
    private readonly dependencies: DatabaseAiFillDependencies,
    private readonly batch: BatchRow,
    private readonly logger: Logger,
    private readonly correlationId: string,
  ) {
    this.prisma = dependencies.prisma;
  }

  async run(): Promise<string> {
    const clientFor = this.dependencies.runApiClientFor;
    if (clientFor === null) {
      this.logger.error('AI fill cannot run: SERVICE_TOKEN_SECRET is not set', undefined, {
        runId: this.batch.id,
      });
      return this.failBeforeStart('ai_fill_unavailable', 'run_ended');
    }
    const settings = await this.dependencies.settings(this.batch.workspaceId);
    let resolved: Resolved;
    try {
      resolved = await this.dependencies.providerFor(this.batch.workspaceId, this.batch.provider);
    } catch (error) {
      if (!(error instanceof WorkspaceKeyUnreadableError)) throw error;
      this.logger.warn('AI fill refused: the workspace key cannot be read', {
        runId: this.batch.id,
        reason: error.reason,
      });
      return this.failBeforeStart('ai_key_unreadable', 'key_unreadable');
    }

    const startedAt = new Date();
    const started = await this.prisma.aiRun.updateMany({
      where: { id: this.batch.id, status: 'PENDING' },
      data: {
        status: 'RUNNING',
        startedAt,
        heartbeatAt: startedAt,
        usedOwnKey: ownKeyPays(this.batch.provider, resolved.key.usedOwnKey),
      },
    });
    if (started.count === 0) return 'skipped';
    await this.announce('running');

    const prices = (await this.prisma.aiModel.findUnique({
      where: { slug: this.batch.model },
      select: { inputMicroUsdPerMTok: true, outputMicroUsdPerMTok: true },
    })) ?? { inputMicroUsdPerMTok: null, outputMicroUsdPerMTok: null };
    const tally = new UsageTally(prices);
    const heartbeat = setInterval(() => this.beat(), AI_RUN_HEARTBEAT_INTERVAL_MS);
    try {
      await this.work({ clientFor, resolved, settings, tally, startedAt });
    } finally {
      clearInterval(heartbeat);
    }
    return this.finish(tally, startedAt);
  }

  private halt(reason: StopReason): void {
    this.stop ??= reason;
    this.abort.abort();
  }

  /** Keeps the reaper away, and is how a cancel in the API reaches the worker. */
  private beat(): void {
    void this.prisma.aiRun
      .updateMany({
        where: { id: this.batch.id, status: 'RUNNING' },
        data: { heartbeatAt: new Date() },
      })
      .then((beat) => {
        if (beat.count > 0) return;
        this.cancelled = true;
        this.halt('run_ended');
      })
      .catch(() => undefined);
  }

  private async work(input: {
    clientFor: (userId: string, runId: string) => ExocortexApiClient;
    resolved: Resolved;
    settings: Settings;
    tally: UsageTally;
    startedAt: Date;
  }): Promise<void> {
    const cells = await this.prisma.databaseAiFillCell.findMany({
      where: { aiRunId: this.batch.id, status: 'QUEUED' },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    const deadline = input.startedAt.getTime() + input.settings['ai.maxRunMs'] - DEADLINE_MARGIN_MS;
    const budget = input.settings['ai.budgetMicroUsdPerRun'];
    let next = 0;
    const lane = async (): Promise<void> => {
      while (this.stop === null) {
        if (Date.now() > deadline) return this.halt('timed_out');
        const cell = cells[next];
        next += 1;
        if (cell === undefined) return;
        try {
          await this.fillOne(cell.id, input);
        } catch (error) {
          // A refusal from the API (the cell was cancelled, the batch ended)
          // concerns that cell; the batch goes on.
          if (!(error instanceof ExocortexApiError)) throw error;
          this.logger.warn('AI fill: the API refused a cell', {
            runId: this.batch.id,
            cellId: cell.id,
            code: error.code,
          });
        }
        if (budget !== null && input.tally.costMicroUsd() >= budget) this.halt('budget_exceeded');
      }
    };
    await Promise.all(Array.from({ length: CELL_CONCURRENCY }, () => lane()));
  }

  private async fillOne(
    cellId: string,
    input: {
      clientFor: (userId: string, runId: string) => ExocortexApiClient;
      resolved: Resolved;
      settings: Settings;
      tally: UsageTally;
    },
  ): Promise<void> {
    const client = input.clientFor(this.batch.createdById, this.batch.id);
    const base = `/api/ai-fills/${this.batch.id}/cells/${cellId}`;
    const post = async (body: AiFillCellResultRequest): Promise<void> => {
      await client.request({
        method: 'POST',
        path: `${base}/result`,
        body,
        responseSchema: aiFillCellResultResponseSchema,
      });
    };
    const material = await client.request({
      method: 'GET',
      path: `${base}/material`,
      responseSchema: aiFillMaterialSchema,
    });
    if (material.status !== 'ready') return;

    const answer = await this.ask(material, input);
    if (answer.ok) {
      const parsed = parseAiFillAnswerText(answer.text);
      await post(
        parsed.ok
          ? { outcome: 'answer', value: parsed.value }
          : { outcome: 'failed', errorCode: 'answer_unreadable' },
      );
      return;
    }
    if (answer.code === 'run_ended') {
      await post({ outcome: 'failed', errorCode: this.stop ?? 'run_ended' }).catch(() => undefined);
      return;
    }
    await post({ outcome: 'failed', errorCode: answer.code });
  }

  /** One model call for one cell, and what its failure means for the batch. */
  private async ask(
    material: Extract<AiFillMaterial, { status: 'ready' }>,
    input: { resolved: Resolved; settings: Settings; tally: UsageTally },
  ): Promise<
    { ok: true; text: string } | { ok: false; code: 'run_ended' | 'key_refused' | 'model_failed' }
  > {
    try {
      const result = await input.resolved.provider.generate({
        messages: buildAiFillPrompt(material),
        model: this.batch.model,
        maxOutputTokens: Math.min(MAX_OUTPUT_TOKENS, input.settings['ai.maxOutputTokens']),
        temperature: 0.2,
        timeoutMs: input.settings['ai.timeoutMs'],
        signal: this.abort.signal,
        correlationId: this.correlationId,
        toolChoice: 'none',
      });
      input.tally.add(result.usage);
      this.consecutiveFailures = 0;
      return { ok: true, text: result.text };
    } catch (error) {
      if (error instanceof AiCancelledError || this.abort.signal.aborted) {
        return { ok: false, code: 'run_ended' };
      }
      const status = error instanceof AiProviderError ? (error.status ?? undefined) : undefined;
      if (keyRefusalReason(status) !== null) {
        this.halt('key_refused');
        return { ok: false, code: 'key_refused' };
      }
      this.consecutiveFailures += 1;
      this.logger.warn('AI fill: the model call for a cell failed', {
        runId: this.batch.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_MODEL_FAILURES) this.halt('model_failed');
      return { ok: false, code: 'model_failed' };
    }
  }

  private async finish(tally: UsageTally, startedAt: Date): Promise<string> {
    const finishedAt = new Date();
    const reason = this.stop;
    await this.prisma.databaseAiFillCell.updateMany({
      where: { aiRunId: this.batch.id, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCELLED', errorCode: reason ?? 'run_ended', finishedAt },
    });
    const { status, errorCode } = this.cancelled
      ? { status: 'CANCELLED' as const, errorCode: null }
      : RUN_END[reason ?? 'done'];

    // The money was spent whoever ended the batch: usage is written even on
    // a cancelled row, the status only where the batch is still the worker's.
    await this.prisma.aiRun.update({
      where: { id: this.batch.id },
      data: { ...tally.columns(), durationMs: finishedAt.getTime() - startedAt.getTime() },
    });
    const closed = await this.prisma.aiRun.updateMany({
      where: { id: this.batch.id, status: 'RUNNING' },
      data: { status, errorCode, finishedAt },
    });
    const outcome = closed.count > 0 ? status.toLowerCase() : 'cancelled';
    if (closed.count > 0) await this.announce(outcome as AiRunStatus);
    this.logger.info('AI fill finished', { runId: this.batch.id, outcome, stop: reason });
    return outcome;
  }

  private async failBeforeStart(errorCode: string, cellCode: AiFillCellErrorCode): Promise<string> {
    const now = new Date();
    const closed = await this.prisma.aiRun.updateMany({
      where: { id: this.batch.id, status: 'PENDING' },
      data: { status: 'FAILED', errorCode, finishedAt: now },
    });
    await this.prisma.databaseAiFillCell.updateMany({
      where: { aiRunId: this.batch.id, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'FAILED', errorCode: cellCode, finishedAt: now },
    });
    if (closed.count > 0) await this.announce('failed');
    return errorCode;
  }

  private async announce(status: AiRunStatus): Promise<void> {
    await this.dependencies.bus
      .publish({
        type: 'database.ai_fill.changed',
        workspaceId: this.batch.workspaceId,
        correlationId: this.correlationId,
        emittedAt: new Date().toISOString(),
        payload: { documentId: this.batch.databaseId, runId: this.batch.id, status },
      })
      .catch((error: unknown) => {
        this.logger.warn('Could not announce an AI fill', {
          runId: this.batch.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

/** How a batch's row ends for each reason it stopped, or for none. */
const RUN_END: Record<
  StopReason | 'done',
  { status: 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED'; errorCode: string | null }
> = {
  done: { status: 'COMPLETED', errorCode: null },
  run_ended: { status: 'COMPLETED', errorCode: null },
  timed_out: { status: 'TIMED_OUT', errorCode: 'ai_timeout' },
  key_refused: { status: 'FAILED', errorCode: 'ai_key_refused' },
  model_failed: { status: 'FAILED', errorCode: 'ai_provider_unavailable' },
  budget_exceeded: { status: 'FAILED', errorCode: 'ai_budget_exceeded' },
};

/** What a batch's model calls cost together, written once when it ends. */
class UsageTally {
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private reported: number | null = null;
  private unreported: AiUsage[] = [];
  private calls = 0;

  constructor(
    private readonly prices: {
      inputMicroUsdPerMTok: number | null;
      outputMicroUsdPerMTok: number | null;
    },
  ) {}

  add(usage: AiUsage): void {
    this.calls += 1;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cachedInputTokens += usage.cachedInputTokens;
    if (usage.providerCostMicroUsd === null) this.unreported.push(usage);
    else this.reported = (this.reported ?? 0) + usage.providerCostMicroUsd;
  }

  /** Reported where the provider said, estimated from the registry's prices where it did not. */
  costMicroUsd(): number {
    return (this.reported ?? 0) + (this.estimated() ?? 0);
  }

  private estimated(): number | null {
    if (this.unreported.length === 0) return null;
    let total = 0;
    for (const usage of this.unreported) {
      const cost = estimateCostMicroUsd(usage, this.prices);
      if (cost === null) return null;
      total += cost;
    }
    return total;
  }

  columns(): Prisma.AiRunUpdateInput {
    if (this.calls === 0) return {};
    const estimated = this.estimated();
    return {
      usage: {
        calls: this.calls,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        cachedInputTokens: this.cachedInputTokens,
      } satisfies Prisma.InputJsonObject,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedInputTokens: this.cachedInputTokens,
      // Same rule as a chat run (issue #10): the estimate only for money the
      // provider named no price for, so the two columns never count the same.
      providerCostMicroUsd: this.reported,
      estimatedCostMicroUsd: this.reported === null ? estimated : null,
    };
  }
}
