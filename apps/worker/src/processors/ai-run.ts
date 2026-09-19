import { type AiProvider, estimateTokens, type VisionPreprocessor } from '@exocortex/ai';
import {
  type AiMessage,
  deriveAiRunTimeouts,
  QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { type AiRun, type PrismaClient, type SearchAdapter } from '@exocortex/database';
import { withSpan } from '@exocortex/logger';
import { type JobContext, type QueueRegistry, type RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { type ResolvedAiKey } from '../ai-key';
import { compactIfNeeded } from '../compaction';
import { type ToolRunner, type ToolRunnerFactory } from '../tool-runner';

import { admitRun } from './ai-run/admission';
import { writeFailure, writeSuccess } from './ai-run/completion';
import { type ResolvedModelRow } from './ai-run/contract';
import { executeRun, type RunRoutingInput } from './ai-run/execution';
import { describeDocumentImages, MAX_IMAGES_PER_RUN } from './ai-run/images';
import {
  buildRunMessages,
  loadConversationMessages,
  resolveModelRow,
  resolveVisionPreprocessor,
} from './ai-run/preparation';

export { type ResolvedModelRow } from './ai-run/contract';
export { toolCallTarget } from './ai-run/execution';

export interface AiRunDependencies {
  prisma: PrismaClient;
  /**
   * The provider this run should use, and whose key is paying (ADR-023).
   *
   * Resolved per run rather than injected once, because a workspace may have
   * brought its own provider key. A workspace without one gets the
   * deployment's provider, which is the object that used to be passed here.
   */
  providerFor: (workspaceId: string) => Promise<{ provider: AiProvider; key: ResolvedAiKey }>;
  bus: RedisEventBus;
  storage: ObjectStorage;
  settings: (workspaceId?: string) => Promise<Settings>;
  /** `null` when `SERVICE_TOKEN_SECRET` is unset: the AI simply runs without tools. */
  toolRunnerFactory: ToolRunnerFactory | null;
  /**
   * Resolves (and caches) a vision companion preprocessor for a given model
   * slug. Deliberately widened to accept `null`, meaning "no explicit
   * companion was configured anywhere -- fall back to the deployment's
   * `OPENROUTER_VISION_MODEL` default" (see the vision companion resolution
   * below); the plan's literal signature took a mandatory `string`, but that
   * left no way to express the "use the env default" branch of the
   * conversation → model-row → env fallback chain it also specifies.
   */
  visionPreprocessorFor: (modelSlug: string | null, apiKey?: string) => VisionPreprocessor | null;
  modelRegistry: (slug: string) => Promise<ResolvedModelRow | null>;
  /** Only used to ask for an endpoint refresh when a `latest` alias turns out to have moved (ADR-032). */
  queues: QueueRegistry;
  /**
   * Both search halves, for the pinned saved queries a system prompt may carry
   * (issue #75). `runSavedQuery` takes the two separately because the stored
   * question decides which of them answers it.
   */
  search: { hybrid: SearchAdapter; keyword: SearchAdapter };
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
 * What the turn loop needs to keep every request inside the providers that can
 * serve it (ADR-032).
 *
 * Built here rather than in the loop because it closes over everything the run
 * already resolved: the prompt's fixed part, the settings, and the way this
 * conversation gets smaller.
 */
function buildRunRouting(input: {
  dependencies: AiRunDependencies;
  modelRow: ResolvedModelRow;
  run: AiRun;
  settings: Settings;
  payload: JobContext<typeof QUEUE_NAMES.ai>['payload'];
  logger: JobContext<typeof QUEUE_NAMES.ai>['logger'];
  base: AiMessage[];
  imageContext: AiMessage | null;
  provider: AiProvider;
  toolsEnabled: boolean;
  requiresReasoningEffort: boolean;
  floorInputTokens: number;
}): RunRoutingInput {
  const { dependencies, modelRow, run, settings, payload, logger, base, imageContext } = input;
  const { prisma, bus } = dependencies;

  return {
    endpoints: modelRow.endpoints,
    aliasTargetSlug: modelRow.aliasTargetSlug,
    usableSharePercent: settings['ai.compactionThresholdPercent'],
    requiresTools: input.toolsEnabled,
    requiresReasoningEffort: input.requiresReasoningEffort,
    floorInputTokens: input.floorInputTokens,
    // A run without a conversation carries its own message list and has
    // nothing to summarise, so it cannot make itself smaller.
    compact:
      run.conversationId === null
        ? null
        : async (budgetInputTokens: number): Promise<AiMessage[]> => {
            await compactIfNeeded({
              prisma,
              provider: input.provider,
              bus,
              runId: run.id,
              conversationId: run.conversationId!,
              workspaceId: run.workspaceId,
              budgetInputTokens,
              systemPromptTokens: estimateTokens(base[0]?.content ?? ''),
              keepRecentMessages: settings['ai.compactionKeepRecentMessages'],
              summaryModel: settings['ai.compactionModelSlug'] ?? run.model,
              correlationId: payload.correlationId,
              logger,
            });
            const reloaded = await loadConversationMessages(prisma, run.conversationId!);
            return imageContext === null
              ? [...base, ...reloaded]
              : [...base, imageContext, ...reloaded];
          },
    onAliasDrift: (actualModel: string): void => {
      // Marked and asked for, not repaired here: the snapshot is rebuilt in one
      // transaction by the refresh, and this run's plan stays valid either way.
      void (async () => {
        await prisma.aiModel.update({
          where: { id: modelRow.id },
          data: { endpointsStaleSince: new Date() },
        });
        await dependencies.queues.enqueue(QUEUE_NAMES.maintenance, {
          correlationId: payload.correlationId,
          task: 'sync-ai-model-routes',
          workspaceId: null,
          documentId: null,
        });
      })().catch((error: unknown) => {
        logger.warn('Could not ask for an endpoint refresh after alias drift', {
          model: run.model,
          actualModel,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    },
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
  const { prisma, bus, storage } = dependencies;
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

    // Whose key pays for this run, and therefore which provider makes the
    // call. Resolved before anything is asked of the provider, so the vision
    // companion below is paid for by the same key as the answer itself.
    const { provider, key } = await dependencies.providerFor(run.workspaceId);

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

    // The admin setting is the ceiling for one answer; a model that caps its own
    // output lower wins, because asking a provider for more than the model can
    // return is a request error. Without this the adapter fell back to its own
    // default and `ai.maxOutputTokens` changed nothing about a run.
    //
    // Resolved before the prompt is built: how much answer is reserved decides
    // how much prompt fits, and which providers could serve it at all (ADR-032).
    const maxOutputTokens = Math.min(
      settings['ai.maxOutputTokens'],
      modelRow.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    );
    const requiresReasoningEffort = run.reasoningLevel !== 'NONE';

    const { base, rest, floorInputTokens } = await buildRunMessages({
      prisma,
      provider,
      bus,
      run,
      settings,
      context: {
        toolsEnabled: tools.enabled,
        contextWindowTokens: modelRow.contextWindowTokens,
        endpoints: modelRow.endpoints,
        reservedOutputTokens: maxOutputTokens,
        requiresReasoningEffort,
        search: dependencies.search,
        payload,
        logger,
      },
    });

    const visionPreprocessor = resolveVisionPreprocessor({
      settings,
      modelRow,
      conversationCompanionSlug: conversation?.visionCompanionSlug ?? null,
      visionPreprocessorFor: (modelSlug) =>
        dependencies.visionPreprocessorFor(modelSlug, key.apiKey),
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
          mutationPolicy: settings['ai.untrustedContentPolicy'],
          // Zero when web research is off, which is also how the fetch tool
          // disappears from the catalogue instead of refusing every call.
          webFetchesPerRun: settings['ai.webResearchEnabled']
            ? settings['ai.webResearchMaxFetchesPerRun']
            : 0,
          toolCallTimeoutMs: timeouts.toolCallTimeoutMs,
          // One run, one session (ADR-022): the unit somebody would want back
          // is "what the assistant did while answering that question".
          agentSession: { externalId: `ai-run-${run.id}`, label: 'eXocortex KI' },
        })
      : null;
    // The image descriptions were produced before the runner existed, and they
    // are text out of an uploaded file like any other (issue #56): the run has
    // already read foreign content by the time the first turn starts.
    if (imageContext !== null) runner?.noteUntrustedContent('attachment');

    await prisma.aiRun.update({
      where: { id: run.id },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        heartbeatAt: new Date(),
        // Written when the run starts, not when it finishes: a run that fails
        // halfway still spent whoever's money it was spending.
        usedOwnKey: key.usedOwnKey,
      },
    });
    await reportProgress(5, 'Antwort wird erzeugt');

    // The span that holds the whole answer together (issue #57): the turns,
    // the tool calls and the provider requests underneath it are what turn
    // "the run took eight seconds" into "the third tool call took six".
    // Ids, durations and usage only -- never a prompt, a message or a result.
    const outcome = await withSpan(
      'ai.run',
      async (span) => {
        const result = await executeRun({
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
          routing: buildRunRouting({
            dependencies,
            modelRow,
            run,
            settings,
            payload,
            logger,
            base,
            imageContext,
            provider,
            toolsEnabled: tools.enabled,
            requiresReasoningEffort,
            floorInputTokens,
          }),
        });
        span.setAttributes({
          'ai.run.tool_iterations': result.toolIterations,
          'ai.usage.input_tokens': result.usage?.inputTokens,
          'ai.usage.output_tokens': result.usage?.outputTokens,
          'ai.usage.cost_micro_usd': result.usage?.providerCostMicroUsd ?? undefined,
        });
        // A run that fails writes its own terminal status rather than throwing
        // (see `QUEUE_JOB_OPTIONS`), so without this the span of a failed run
        // would look exactly like the span of a successful one.
        if (result.failure !== null) span.setStatus('error', result.failure.code);
        return result;
      },
      {
        correlationId: payload.correlationId,
        attributes: {
          'ai.run.id': run.id,
          'ai.model': run.model,
          'ai.provider': provider.id,
          'ai.tools_enabled': tools.enabled,
          'exocortex.workspace_id': run.workspaceId,
        },
      },
    );

    if (outcome.failure !== null) {
      await writeFailure({
        prisma,
        bus,
        run,
        payload,
        logger,
        failure: outcome.failure,
        outcome,
        modelRow,
      });
      return;
    }
    await writeSuccess({ prisma, bus, run, payload, logger, reportProgress, outcome, modelRow });
  };
}
