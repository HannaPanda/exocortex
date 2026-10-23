import {
  type AiProvider,
  type DecisionProvider,
  estimateTokens,
  type VisionPreprocessor,
} from '@exocortex/ai';
import {
  type AiMessage,
  type AiWriteMode,
  deriveAiRunTimeouts,
  type ProviderRoutingOverride,
  QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { type AiRun, type PrismaClient, type SearchAdapter } from '@exocortex/database';
import { currentTraceIds, withSpan } from '@exocortex/logger';
import { type JobContext, type QueueRegistry, type RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { type ResolvedAiKey } from '../ai-key';
import { compactIfNeeded } from '../compaction';
import { type ExternalToolLoader } from '../external-mcp-tools';
import { type ToolImageDescriber } from '../tool-images';
import { type ToolRunnerFactory } from '../tool-runner';

import { admitRun, refuseRun } from './ai-run/admission';
import {
  profileColumns,
  profileLimits,
  profileMessage,
  resolveRunProfile,
  type RunProfile,
} from './ai-run/agent-profile';
import { writeOutcome } from './ai-run/completion';
import { contextEvent } from './ai-run/context-record';
import { type ResolvedModelRow } from './ai-run/contract';
import {
  type EvalHold,
  evalLimits,
  evalProviderRouting,
  resolveEvalHold,
} from './ai-run/eval-hold';
import { executeRun } from './ai-run/execution';
import { type RunRoutingInput } from './ai-run/execution-types';
import { describeDocumentImages, MAX_IMAGES_PER_RUN } from './ai-run/images';
import {
  buildRunMessages,
  loadConversationMessages,
  resolveModelRow,
  resolveToolImageDescriber,
  resolveVisionPreprocessor,
  withConfiguredEndpoints,
} from './ai-run/preparation';
import { prepareRunTools, type RunPolicy } from './ai-run/run-tools';
import { RunTimeline } from './ai-run/timeline';
import { resolveRunWriteMode, writeModeColumn, writeModeMessage } from './ai-run/write-mode';

export { type ResolvedModelRow } from './ai-run/contract';
export { toolCallTarget } from './ai-run/wire';

export interface AiRunDependencies {
  prisma: PrismaClient;
  /**
   * The provider this run should use, and whose key is paying (ADR-023).
   *
   * Resolved per run rather than injected once, because a workspace may have
   * brought its own provider key. A workspace without one gets the
   * deployment's provider, which is the object that used to be passed here.
   *
   * `providerId` is the run's `provider` column (issue #187): a checked
   * subscription preset such as `cline` answers through its own endpoint,
   * anything else through OpenRouter. `openRouter` is the OpenRouter provider
   * the same key pays for, which a configured compaction model needs because
   * its slug is an OpenRouter slug; absent means `provider` is that one.
   */
  providerFor: (
    workspaceId: string,
    providerId?: string,
  ) => Promise<{ provider: AiProvider; key: ResolvedAiKey; openRouter?: AiProvider }>;
  bus: RedisEventBus;
  storage: ObjectStorage;
  settings: (workspaceId?: string) => Promise<Settings>;
  /** `null` when `SERVICE_TOKEN_SECRET` is unset: the AI simply runs without tools. */
  toolRunnerFactory: ToolRunnerFactory | null;
  /** The approved tools of a workspace's external MCP servers (issue #196); absent in tests. */
  externalTools?: ExternalToolLoader;
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
  /**
   * Who answers the tool routing's question (issue #206), with the key that
   * pays for the run's OpenRouter calls; `null` when there is nobody to ask.
   * Optional so a test that does not care about routing need not build one:
   * absent, Jev is never asked and a run with the setting on falls back.
   */
  decisionsFor?: (apiKey: string) => DecisionProvider | null;
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
  timeline: RunTimeline;
  toolsEnabled: boolean;
  requiresReasoningEffort: boolean;
  floorInputTokens: number;
  /** The agent profile's routing keys (issue #143), laid over the configured ones. */
  preferences: ProviderRoutingOverride | null;
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
    preferences: input.preferences,
    // A run without a conversation carries its own message list and has
    // nothing to summarise, so it cannot make itself smaller.
    compact:
      run.conversationId === null
        ? null
        : async (budgetInputTokens: number): Promise<AiMessage[]> => {
            await input.timeline.timed(
              () =>
                compactIfNeeded({
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
                }),
              (result) =>
                result.compacted
                  ? {
                      kind: 'compaction',
                      data: { summarizedMessages: result.summarizedMessages, trigger: 'route' },
                    }
                  : null,
            );
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
 * The run's write mode, role and limits, each the strictest of the settings,
 * the work item and the agent profile. A profile can only ever take
 * something away, so every number here is a minimum.
 */
async function resolveRunPolicy(input: {
  prisma: PrismaClient;
  run: AiRun;
  settings: Settings;
  profile: RunProfile | null;
  evalHold: EvalHold | null;
}): Promise<RunPolicy> {
  const { prisma, run, settings, profile, evalHold } = input;
  const writeMode = await resolveRunWriteMode({
    prisma,
    run,
    settings,
    profileWriteMode: profile?.snapshot.writeMode ?? null,
    evalWriteMode: evalHold?.writeMode ?? null,
  });
  const roleNote = await profileMessage({ prisma, profile, workspaceId: run.workspaceId });
  const modeNote = writeModeMessage(writeMode, run.workItemId !== null);
  const base = deriveAiRunTimeouts(settings);
  const limits = evalLimits(
    evalHold,
    profileLimits(profile, {
      budgetMicroUsd: settings['ai.budgetMicroUsdPerRun'],
      maxToolIterations: settings['ai.maxToolIterations'],
      runBudgetMs: base.runBudgetMs,
    }),
  );
  return {
    profile,
    evalHold,
    writeMode,
    notes: [
      ...(roleNote === null ? [] : [{ key: 'agent_role' as const, message: roleNote }]),
      ...(modeNote === null ? [] : [{ key: 'write_mode' as const, message: modeNote }]),
    ],
    timeouts: {
      ...base,
      runBudgetMs: limits.runBudgetMs,
      toolCallTimeoutMs: Math.min(base.toolCallTimeoutMs, limits.runBudgetMs),
    },
    budgetMicroUsd: limits.budgetMicroUsd,
    maxToolIterations: limits.maxToolIterations,
  };
}

/**
 * What a run gets to know about pictures (ADR-012, ADR-088): the open page's
 * images, described before the first turn, and who describes a picture a tool
 * returns later. Both read the same companion choice.
 */
async function prepareRunVision(input: {
  dependencies: AiRunDependencies;
  run: AiRun;
  settings: Settings;
  modelRow: ResolvedModelRow;
  conversationCompanionSlug: string | null;
  apiKey: string;
  correlationId: string;
  logger: JobContext<typeof QUEUE_NAMES.ai>['logger'];
}): Promise<{ imageContext: AiMessage | null; describeImage: ToolImageDescriber | null }> {
  const { dependencies, run, settings, logger } = input;
  const choice = {
    settings,
    modelRow: input.modelRow,
    conversationCompanionSlug: input.conversationCompanionSlug,
    visionPreprocessorFor: (modelSlug: string | null) =>
      dependencies.visionPreprocessorFor(modelSlug, input.apiKey),
  };
  const describeImage = resolveToolImageDescriber({
    ...choice,
    correlationId: input.correlationId,
  });
  const visionPreprocessor = resolveVisionPreprocessor({ ...choice, run, logger });
  if (run.documentId === null || visionPreprocessor === null) {
    return { imageContext: null, describeImage };
  }
  const imageContext = await describeDocumentImages({
    prisma: dependencies.prisma,
    storage: dependencies.storage,
    visionPreprocessor,
    workspaceId: run.workspaceId,
    documentId: run.documentId,
    correlationId: input.correlationId,
    logger,
    maxImages: settings['ai.visionMaxImagesPerRun'] ?? MAX_IMAGES_PER_RUN,
  }).catch((error: unknown) => {
    logger.info('Skipping image preprocessing for this run', {
      runId: run.id,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  return { imageContext, describeImage };
}

/**
 * The eval attempt (issue #146) and the agent profile (issue #143) a run
 * works under, and the provider keys both lay over the configuration. Null
 * when the run was refused, because an attempt that cannot hold its run must
 * not let it run unheld.
 */
async function resolveRunHold(input: {
  prisma: PrismaClient;
  bus: RedisEventBus;
  run: AiRun;
  payload: JobContext<typeof QUEUE_NAMES.ai>['payload'];
  logger: JobContext<typeof QUEUE_NAMES.ai>['logger'];
}): Promise<{
  hold: EvalHold | null;
  profile: RunProfile | null;
  providerPreferences: ProviderRoutingOverride | null;
} | null> {
  const { prisma, run } = input;
  const evalHold = await resolveEvalHold({ prisma, run });
  if (evalHold.kind === 'refused') {
    await refuseRun({
      ...input,
      errorCode: 'eval_attempt_invalid',
      reason: `The eval attempt cannot hold this run: ${evalHold.reason}`,
    });
    return null;
  }
  const hold = evalHold.kind === 'held' ? evalHold.hold : null;
  const profile = await resolveRunProfile({
    prisma,
    run,
    ...(hold === null ? {} : { evalProfileId: hold.agentProfileId }),
  });
  return {
    hold,
    profile,
    providerPreferences: evalProviderRouting(profile?.providerRouting ?? null, hold),
  };
}

/** The row as it starts running, with what it is held to and where its logs are. */
async function markRunning(input: {
  prisma: PrismaClient;
  run: AiRun;
  usedOwnKey: boolean;
  writeMode: AiWriteMode;
  profile: RunProfile | null;
  correlationId: string;
}): Promise<void> {
  await input.prisma.aiRun.update({
    where: { id: input.run.id },
    data: {
      status: 'RUNNING',
      startedAt: new Date(),
      heartbeatAt: new Date(),
      // Written when the run starts, not when it finishes: a run that fails
      // halfway still spent whoever's money it was spending.
      usedOwnKey: input.usedOwnKey,
      writeMode: writeModeColumn(input.writeMode),
      // Where the logs of this run are (issue #145): every line it writes
      // carries this id.
      correlationId: input.correlationId,
      // What the profile said at this moment (issue #143), so a later edit
      // of the profile does not rewrite what this run was held to.
      ...profileColumns(input.profile),
    },
  });
}

/**
 * Keeps the run's trace id on its row (issue #145), so the inspector can
 * name the trace. Called from inside the run's span, the only place the id
 * exists; nothing is written when tracing is off.
 */
async function recordTraceId(prisma: PrismaClient, runId: string): Promise<void> {
  const traceId = currentTraceIds()?.traceId ?? null;
  if (traceId !== null) await prisma.aiRun.update({ where: { id: runId }, data: { traceId } });
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
  const { prisma, bus } = dependencies;
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
    // What the run does, step by step, for the run inspector (issue #145).
    const timeline = new RunTimeline(prisma, run.id, logger);

    // Whose key pays for this run, and therefore which provider makes the
    // call. Resolved before anything is asked of the provider, so the vision
    // companion below is paid for by the same key as the answer itself.
    const { provider, key, openRouter } = await dependencies.providerFor(
      run.workspaceId,
      run.provider,
    );
    // A summary is written by the conversation's own model unless a
    // compaction model is configured, and that one is an OpenRouter slug: a
    // subscription endpoint would bill it outside the plan, or refuse it.
    const summaryProvider =
      settings['ai.compactionModelSlug'] === null ? provider : (openRouter ?? provider);

    // The agent profile this run works under, if it is an attempt at work
    // that has one (issue #143): its role, its limits, its tools, and routing
    // keys that narrow the endpoints before anything is planned.
    const held = await resolveRunHold({ prisma, bus, run, payload, logger });
    if (held === null) return;
    const { hold, profile, providerPreferences } = held;

    const modelRow = withConfiguredEndpoints(
      await resolveModelRow({
        modelRegistry: dependencies.modelRegistry,
        provider,
        run,
        logger,
      }),
      settings,
      providerPreferences,
    );
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

    const { base, rest, floorInputTokens, promptSections } = await buildRunMessages({
      prisma,
      // Only a compaction asks the provider anything while the prompt is built.
      provider: summaryProvider,
      bus,
      run,
      settings,
      timeline,
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

    const { imageContext, describeImage } = await prepareRunVision({
      dependencies,
      run,
      settings,
      modelRow,
      conversationCompanionSlug: conversation?.visionCompanionSlug ?? null,
      apiKey: key.apiKey,
      correlationId: payload.correlationId,
      logger,
    });
    // The mode, the role and the limits this run is held to (issues #141 and
    // #143): told to the model up front, enforced by the loop and, through
    // its signed token, by the API.
    const policy = await resolveRunPolicy({ prisma, run, settings, profile, evalHold: hold });
    const { timeouts, writeMode } = policy;
    // Who chooses the tools, the loop that offers them, and what the prompt
    // says about the rest (issues #121 and #206).
    const { runner, notes } = await prepareRunTools({
      enabled: tools.enabled,
      dependencies,
      run,
      settings,
      rest,
      policy,
      apiKey: key.apiKey,
      correlationId: payload.correlationId,
      timeline,
      describeImage,
      logger,
    });
    // The image descriptions were produced before the runner existed, and they
    // are text out of an uploaded file like any other (issue #56): the run has
    // already read foreign content by the time the first turn starts.
    if (imageContext !== null) runner?.noteUntrustedContent('attachment');

    const preamble: AiMessage[] = [...base, ...notes.map((note) => note.message)];
    const messages: AiMessage[] = [
      ...preamble,
      ...(imageContext === null ? [] : [imageContext]),
      ...rest,
    ];

    timeline.record(
      contextEvent({
        promptSections,
        notes,
        imageContext,
        documentId: run.documentId,
        conversation: rest,
        tools: runner?.toolContext() ?? null,
      }),
    );

    await markRunning({
      prisma,
      run,
      usedOwnKey: key.usedOwnKey,
      writeMode,
      profile,
      correlationId: payload.correlationId,
    });
    await reportProgress(5, 'generating');

    // The span that holds the whole answer together (issue #57): the turns,
    // the tool calls and the provider requests underneath it are what turn
    // "the run took eight seconds" into "the third tool call took six".
    // Ids, durations and usage only -- never a prompt, a message or a result.
    const outcome = await withSpan(
      'ai.run',
      async (span) => {
        await recordTraceId(prisma, run.id);
        const result = await executeRun({
          prisma,
          provider,
          bus,
          run,
          payload,
          logger,
          timeouts,
          runner,
          timeline,
          toolsEnabled: tools.enabled,
          maxOutputTokens,
          maxToolIterations: tools.enabled ? policy.maxToolIterations : 0,
          budgetMicroUsd: policy.budgetMicroUsd,
          messages,
          routing: buildRunRouting({
            dependencies,
            modelRow,
            run,
            settings,
            payload,
            logger,
            // With the notes, so a compaction between turns keeps the run's
            // mode, role and tool offer rather than only the system prompt.
            base: preamble,
            imageContext,
            // The routing input's provider writes compaction summaries, nothing else.
            provider: summaryProvider,
            timeline,
            toolsEnabled: tools.enabled,
            requiresReasoningEffort,
            floorInputTokens,
            preferences: providerPreferences,
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

    // Every step is written before the terminal status, so a client that
    // reloads on the status change never sees a timeline that is still growing.
    await timeline.flush();
    await writeOutcome({ prisma, bus, run, payload, logger, reportProgress, outcome, modelRow });
  };
}
