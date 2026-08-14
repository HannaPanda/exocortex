import { type AiProvider, type VisionPreprocessor } from '@exocortex/ai';
import { type AiMessage, deriveAiRunTimeouts, type QUEUE_NAMES, type Settings } from '@exocortex/contracts';
import { type AiRun, type PrismaClient } from '@exocortex/database';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { type ToolRunner } from '../tool-runner';

import { admitRun } from './ai-run/admission';
import { writeFailure, writeSuccess } from './ai-run/completion';
import { type ResolvedModelRow } from './ai-run/contract';
import { executeRun } from './ai-run/execution';
import { describeDocumentImages, MAX_IMAGES_PER_RUN } from './ai-run/images';
import {
  buildRunMessages,
  resolveModelRow,
  resolveVisionPreprocessor,
} from './ai-run/preparation';

export { type ResolvedModelRow } from './ai-run/contract';
export { toolCallTarget } from './ai-run/execution';

export interface AiRunDependencies {
  prisma: PrismaClient;
  provider: AiProvider;
  bus: RedisEventBus;
  storage: ObjectStorage;
  settings: () => Promise<Settings>;
  /** `null` when `SERVICE_TOKEN_SECRET` is unset: the AI simply runs without tools. */
  toolRunnerFactory:
    | ((input: { userId: string; includeMutating: boolean; toolCallTimeoutMs: number }) => ToolRunner)
    | null;
  /**
   * Resolves (and caches) a vision companion preprocessor for a given model
   * slug. Deliberately widened to accept `null`, meaning "no explicit
   * companion was configured anywhere -- fall back to the deployment's
   * `OPENROUTER_VISION_MODEL` default" (see the vision companion resolution
   * below); the plan's literal signature took a mandatory `string`, but that
   * left no way to express the "use the env default" branch of the
   * conversation → model-row → env fallback chain it also specifies.
   */
  visionPreprocessorFor: (modelSlug: string | null) => VisionPreprocessor | null;
  modelRegistry: (slug: string) => Promise<ResolvedModelRow | null>;
}

/**
 * Whether this run may call tools at all.
 *
 * Decided before the message list because the system prompt has to tell the
 * model whether it can fetch the open page itself or has to say it cannot.
 */
function resolveToolAvailability(input: {
  settings: Settings;
  modelRow: ResolvedModelRow;
  run: AiRun;
  hasToolRunnerFactory: boolean;
}): { enabled: boolean; missingServiceToken: boolean } {
  const wanted =
    input.settings['ai.toolsEnabled'] &&
    input.modelRow.supportsTools &&
    input.run.conversationId !== null;
  return {
    enabled: wanted && input.hasToolRunnerFactory,
    missingServiceToken: wanted && !input.hasToolRunnerFactory,
  };
}

/**
 * Executes an AI run outside the API process.
 *
 * The provider is behind the `AiProvider` contract, so switching from the mock
 * provider to a real one changes configuration only. CLI agents (Claude Code,
 * Codex) will be executed from here too, inside their own isolated sandbox, and
 * never inside the API or the Next.js server (docs/ai-architecture.md).
 *
 * This function is the sequence, not the work: admission, preparation, the
 * provider loop and the terminal write each live in `ai-run/`.
 */
export function createAiRunProcessor(dependencies: AiRunDependencies) {
  const { prisma, provider, bus, storage } = dependencies;
  let loggedMissingServiceTokenWarning = false;

  return async ({
    payload,
    logger,
    reportProgress,
  }: JobContext<typeof QUEUE_NAMES.ai>): Promise<void> => {
    const admitted = await admitRun({
      prisma,
      bus,
      payload,
      logger,
      settings: dependencies.settings,
    });
    if (admitted === null) return;
    const { run, settings } = admitted;

    const modelRow = await resolveModelRow({
      modelRegistry: dependencies.modelRegistry,
      provider,
      run,
      logger,
    });
    const conversation =
      run.conversationId === null
        ? null
        : await prisma.aiConversation.findUnique({ where: { id: run.conversationId } });

    const tools = resolveToolAvailability({
      settings,
      modelRow,
      run,
      hasToolRunnerFactory: dependencies.toolRunnerFactory !== null,
    });
    if (tools.missingServiceToken && !loggedMissingServiceTokenWarning) {
      logger.warn('Tool calling is unavailable: SERVICE_TOKEN_SECRET is not configured');
      loggedMissingServiceTokenWarning = true;
    }

    const { base, rest } = await buildRunMessages({
      prisma,
      provider,
      bus,
      run,
      settings,
      context: {
        toolsEnabled: tools.enabled,
        contextWindowTokens: modelRow.contextWindowTokens,
        payload,
        logger,
      },
    });

    const visionPreprocessor = resolveVisionPreprocessor({
      settings,
      modelRow,
      conversationCompanionSlug: conversation?.visionCompanionSlug ?? null,
      visionPreprocessorFor: dependencies.visionPreprocessorFor,
      run,
      logger,
    });
    const imageContext =
      run.documentId !== null && visionPreprocessor !== null
        ? await describeDocumentImages({
            prisma,
            storage,
            visionPreprocessor,
            workspaceId: run.workspaceId,
            documentId: run.documentId,
            correlationId: payload.correlationId,
            logger,
            maxImages: settings['ai.visionMaxImagesPerRun'] ?? MAX_IMAGES_PER_RUN,
          }).catch((error: unknown) => {
            logger.info('Skipping image preprocessing for this run', {
              runId: run.id,
              reason: error instanceof Error ? error.message : String(error),
            });
            return null;
          })
        : null;
    const messages: AiMessage[] =
      imageContext === null ? [...base, ...rest] : [...base, imageContext, ...rest];

    // Derived once, ahead of the tool runner: a tool call needs its own
    // timeout before the run's clocks are otherwise started below.
    const timeouts = deriveAiRunTimeouts(settings);
    const runner: ToolRunner | null = tools.enabled
      ? dependencies.toolRunnerFactory!({
          userId: run.createdById,
          includeMutating: settings['ai.mutatingToolsEnabled'],
          toolCallTimeoutMs: timeouts.toolCallTimeoutMs,
        })
      : null;

    // The admin setting is the ceiling for one answer; a model that caps its own
    // output lower wins, because asking a provider for more than the model can
    // return is a request error. Without this the adapter fell back to its own
    // default and `ai.maxOutputTokens` changed nothing about a run.
    const maxOutputTokens = Math.min(
      settings['ai.maxOutputTokens'],
      modelRow.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    );

    await prisma.aiRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', startedAt: new Date(), heartbeatAt: new Date() },
    });
    await reportProgress(5, 'Antwort wird erzeugt');

    const outcome = await executeRun({
      prisma,
      provider,
      bus,
      run,
      payload,
      logger,
      timeouts,
      runner,
      toolsEnabled: tools.enabled,
      maxOutputTokens,
      maxToolIterations: tools.enabled ? settings['ai.maxToolIterations'] : 0,
      budgetMicroUsd: settings['ai.budgetMicroUsdPerRun'],
      messages,
    });

    if (outcome.failure !== null) {
      await writeFailure({
        prisma,
        bus,
        run,
        payload,
        logger,
        failure: outcome.failure,
        outcome,
      });
      return;
    }
    await writeSuccess({ prisma, bus, run, payload, logger, reportProgress, outcome });
  };
}
