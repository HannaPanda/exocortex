import { type AiProvider } from '@exocortex/ai';
import { aiMessageSchema, type AiUsage, type QUEUE_NAMES } from '@exocortex/contracts';
import { Prisma, type PrismaClient } from '@exocortex/database';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';

export interface AiRunDependencies {
  prisma: PrismaClient;
  provider: AiProvider;
  bus: RedisEventBus;
  /** Hard timeout for a single run. */
  timeoutMs?: number;
}

/**
 * Executes an AI run outside the API process.
 *
 * The provider is behind the `AiProvider` contract, so switching from the mock
 * provider to a real one changes configuration only. CLI agents (Claude Code,
 * Codex) will be executed from here too, inside their own isolated sandbox, and
 * never inside the API or the Next.js server (docs/ai-architecture.md).
 */
export function createAiRunProcessor(dependencies: AiRunDependencies) {
  const { prisma, provider, bus } = dependencies;
  const timeoutMs = dependencies.timeoutMs ?? 60_000;

  return async ({
    payload,
    logger,
    reportProgress,
  }: JobContext<typeof QUEUE_NAMES.ai>): Promise<void> => {
    const run = await prisma.aiRun.findUnique({ where: { id: payload.runId } });
    if (run === null) {
      logger.warn('Skipping AI run: record not found', { runId: payload.runId });
      return;
    }
    if (run.status === 'CANCELLED') {
      logger.info('Skipping AI run: cancelled before start', { runId: run.id });
      return;
    }
    if (run.status !== 'PENDING') {
      // Idempotency: a retried job must not produce a second answer.
      logger.info('Skipping AI run: already processed', { runId: run.id, status: run.status });
      return;
    }

    const messages = aiMessageSchema.array().parse(run.messages);

    await prisma.aiRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    await reportProgress(5, 'Antwort wird erzeugt');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let text = '';
    let usage: AiUsage | null = null;
    let failure: { code: string; message: string } | null = null;

    try {
      for await (const event of provider.stream({
        messages,
        model: run.model,
        correlationId: payload.correlationId,
        signal: controller.signal,
        timeoutMs,
      })) {
        switch (event.type) {
          case 'delta': {
            text += event.text;
            await bus.publish({
              type: 'ai.run.progress',
              workspaceId: run.workspaceId,
              correlationId: payload.correlationId,
              emittedAt: new Date().toISOString(),
              payload: {
                runId: run.id,
                status: 'running',
                delta: event.text,
                sequence: event.sequence,
              },
            });
            break;
          }
          case 'usage':
            usage = event.usage;
            break;
          case 'error':
            failure = { code: event.code, message: event.message };
            break;
          case 'start':
          case 'done':
          default:
            break;
        }
      }
    } catch (error) {
      failure = {
        code: 'ai_provider_unavailable',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }

    if (failure !== null) {
      await prisma.aiRun.update({
        where: { id: run.id },
        data: {
          status: failure.code === 'ai_cancelled' ? 'CANCELLED' : 'FAILED',
          errorCode: failure.code,
          finishedAt: new Date(),
          resultText: text.length > 0 ? text : null,
        },
      });
      await bus.publish({
        type: 'ai.run.failed',
        workspaceId: run.workspaceId,
        correlationId: payload.correlationId,
        emittedAt: new Date().toISOString(),
        payload: {
          runId: run.id,
          status: failure.code === 'ai_cancelled' ? 'cancelled' : 'failed',
          errorCode: failure.code,
          reason: failure.message,
        },
      });
      logger.warn('AI run failed', { runId: run.id, code: failure.code });
      return;
    }

    await prisma.aiRun.update({
      where: { id: run.id },
      data: {
        status: 'COMPLETED',
        resultText: text,
        usage: usage === null ? Prisma.JsonNull : (usage as unknown as Prisma.InputJsonObject),
        finishedAt: new Date(),
      },
    });

    await bus.publish({
      type: 'ai.run.completed',
      workspaceId: run.workspaceId,
      correlationId: payload.correlationId,
      emittedAt: new Date().toISOString(),
      payload: { runId: run.id, status: 'completed', text, usage },
    });

    await reportProgress(100, 'Antwort fertig');
    logger.info('AI run completed', {
      runId: run.id,
      provider: run.provider,
      outputTokens: usage?.outputTokens ?? 0,
    });
  };
}
