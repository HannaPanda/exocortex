import { type AiProvider, estimateTokens, type VisionPreprocessor } from '@exocortex/ai';
import {
  type AiMessage,
  type AiRunTimeouts,
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
import { type ToolRunner, type ToolRunnerFactory } from '../tool-runner';

import { admitRun, refuseRun } from './ai-run/admission';
import {
  profileColumns,
  profileLimits,
  profileMessage,
  profileToolDomains,
  resolveRunProfile,
  type RunProfile,
} from './ai-run/agent-profile';
import { writeOutcome } from './ai-run/completion';
import { contextEvent } from './ai-run/context-record';
import { type ResolvedModelRow } from './ai-run/contract';
import { executeRun, type RunRoutingInput } from './ai-run/execution';
import { describeDocumentImages, MAX_IMAGES_PER_RUN } from './ai-run/images';
import {
  buildRunMessages,
  loadConversationMessages,
  resolveModelRow,
  resolveVisionPreprocessor,
  taskTextFor,
  withConfiguredEndpoints,
} from './ai-run/preparation';
import {
  type EvalHold,
  evalLimits,
  evalProviderRouting,
  evalToolDomains,
  resolveEvalHold,
} from './ai-run/eval-hold';
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

/** What holds one run: its mode, its role, its limits (issues #141 and #143). */
interface RunPolicy {
  profile: RunProfile | null;
  /** The eval attempt's case, when the run is one (issue #146). */
  evalHold: EvalHold | null;
  writeMode: AiWriteMode;
  /** System messages before the conversation: the role, then the mode. */
  notes: { key: 'agent_role' | 'write_mode'; message: AiMessage }[];
  timeouts: AiRunTimeouts;
  budgetMicroUsd: number;
  maxToolIterations: number;
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

/** The tool loop of one run, told what it may offer and what it may call. */
function createRunToolRunner(input: {
  factory: ToolRunnerFactory;
  run: AiRun;
  settings: Settings;
  rest: AiMessage[];
  policy: RunPolicy;
}): ToolRunner {
  const { run, settings, policy } = input;
  const proposing = policy.writeMode === 'propose';
  return input.factory({
    userId: run.createdById,
    includeMutating: settings['ai.mutatingToolsEnabled'],
    mutationPolicy: settings['ai.untrustedContentPolicy'],
    writeMode: policy.writeMode,
    // Zero when web research is off, which is also how the fetch tool
    // disappears from the catalogue instead of refusing every call.
    webFetchesPerRun: settings['ai.webResearchEnabled']
      ? settings['ai.webResearchMaxFetchesPerRun']
      : 0,
    // Which part of the catalogue this run hears about (issue #121). The
    // task's own words decide, plus one fact the words cannot say: a database
    // view is open, so the row and column tools are needed before anybody
    // writes the word "Datenbank".
    taskText: taskTextFor(input.rest),
    requiredDomains: [
      ...(run.databaseViewId === null ? [] : (['databases'] as const)),
      // A proposing run needs the proposal tools whatever its words say.
      ...(proposing ? (['changesets'] as const) : []),
    ],
    // The agent profile's domains are a limit, not an offer (issue #143),
    // and an eval case can narrow them further (issue #146).
    allowedDomains: evalToolDomains(
      profileToolDomains(policy.profile, { onWorkItem: run.workItemId !== null, proposing }),
      policy.evalHold,
      proposing ? ['changesets'] : [],
    ),
    // An eval attempt is always held to its workspace, and in the fixture
    // mode to its sandbox (issue #146).
    confinedWorkspaceId:
      policy.profile?.snapshot.confineToWorkspace === true || policy.evalHold !== null
        ? run.workspaceId
        : null,
    confinedPageRootId: policy.evalHold?.pageRootId ?? null,
    toolCallTimeoutMs: policy.timeouts.toolCallTimeoutMs,
    // One run, one session (ADR-022): the unit somebody would want back is
    // "what the assistant did while answering that question".
    agentSession: { externalId: `ai-run-${run.id}`, label: 'eXocortex KI' },
    runId: run.id,
  });
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
    // What the run does, step by step, for the run inspector (issue #145).
    const timeline = new RunTimeline(prisma, run.id, logger);

    // Whose key pays for this run, and therefore which provider makes the
    // call. Resolved before anything is asked of the provider, so the vision
    // companion below is paid for by the same key as the answer itself.
    const { provider, key } = await dependencies.providerFor(run.workspaceId);

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
      provider,
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
    // The mode, the role and the limits this run is held to (issues #141 and
    // #143): told to the model up front, enforced by the loop and, through
    // its signed token, by the API.
    const policy = await resolveRunPolicy({ prisma, run, settings, profile, evalHold: hold });
    const messages: AiMessage[] = [
      ...base,
      ...policy.notes.map((note) => note.message),
      ...(imageContext === null ? [] : [imageContext]),
      ...rest,
    ];
    const { timeouts, writeMode } = policy;
    const runner: ToolRunner | null = tools.enabled
      ? createRunToolRunner({
          factory: dependencies.toolRunnerFactory!,
          run,
          settings,
          rest,
          policy,
        })
      : null;
    // The image descriptions were produced before the runner existed, and they
    // are text out of an uploaded file like any other (issue #56): the run has
    // already read foreign content by the time the first turn starts.
    if (imageContext !== null) runner?.noteUntrustedContent('attachment');

    timeline.record(
      contextEvent({
        promptSections,
        notes: policy.notes,
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
            base,
            imageContext,
            provider,
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
