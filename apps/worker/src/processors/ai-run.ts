import {
  type AiGenerateResult,
  type AiProvider,
  type AiToolCall,
  estimateMessageTokens,
  estimateTokens,
  type VisionPreprocessor,
} from '@exocortex/ai';
import {
  AI_RUN_HEARTBEAT_STALE_MS,
  type AiMessage,
  aiMessageSchema,
  type AiUsage,
  deriveAiRunTimeouts,
  type QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import {
  type AiConversationRole as AiConversationRolePrisma,
  type AiReasoningLevel as AiReasoningLevelPrisma,
  Prisma,
  type PrismaClient,
} from '@exocortex/database';
import { type ProseMirrorNode } from '@exocortex/editor';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { compactIfNeeded } from '../compaction';
import { buildSystemPrompt } from '../system-prompt';
import { type ToolRunner } from '../tool-runner';

/** Fields read directly from `ai_model` -- never imported from apps/api (rule 6/package boundaries). */
export interface ResolvedModelRow {
  id: string;
  slug: string;
  provider: string;
  contextWindowTokens: number;
  maxOutputTokens: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  reasoningLevels: readonly AiReasoningLevelPrisma[];
  /** Slug of the vision companion, or null when the model sees images itself or none is configured. */
  visionCompanionSlug: string | null;
}

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

/** No page needs more than this many images described for one answer (default; overridden by `ai.visionMaxImagesPerRun`). */
const MAX_IMAGES_PER_RUN = 4;

/** Hard cap on how many characters of ALWAYS rule pages the system prompt may carry. Not admin-configurable. */
const MAX_RULE_CHARS = 20_000;

const ATTACHMENT_DOWNLOAD_PATH = /^\/api\/attachments\/([^/]+)\/download$/;

/**
 * How often one run may pick up an answer that hit the output cap.
 *
 * Bounded on purpose: a model that keeps running into the limit is producing
 * something the limit is not the right fix for, and every retry costs a full
 * prompt again.
 */
const MAX_TRUNCATION_RETRIES = 3;

/** Sent after a text answer was cut off, to pick it up without repeating anything. */
const TRUNCATION_CONTINUE_PROMPT =
  'Deine vorige Antwort wurde am Ausgabelimit abgeschnitten. Setze genau an der Abbruchstelle fort: ' +
  'keine Einleitung, keine Wiederholung, kein Neuanfang.';

/** Sent after a tool call was cut off mid-arguments, so the retry stays inside the limit. */
const TRUNCATION_TOOL_RETRY_PROMPT =
  'Dein letzter Werkzeugaufruf wurde am Ausgabelimit abgeschnitten und deshalb nicht ausgeführt. ' +
  'Wiederhole ihn mit deutlich weniger Inhalt pro Aufruf: schreibe lange Inhalte in mehreren Schritten, ' +
  'den ersten mit mode "replace", die weiteren mit mode "append".';

const CONVERSATION_ROLE_TO_LOWER: Record<AiConversationRolePrisma, AiMessage['role']> = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
};

const REASONING_LEVEL_TO_LOWER: Record<AiReasoningLevelPrisma, 'none' | 'minimal' | 'low' | 'medium' | 'high'> = {
  NONE: 'none',
  MINIMAL: 'minimal',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
};

/** Depth-first collection of every `image` node's `src` attribute. */
function collectImageSources(node: ProseMirrorNode | null | undefined): string[] {
  if (node === null || node === undefined) return [];
  const sources: string[] = [];
  if (node.type === 'image' && typeof node.attrs?.src === 'string' && node.attrs.src.length > 0) {
    sources.push(node.attrs.src);
  }
  for (const child of node.content ?? []) sources.push(...collectImageSources(child));
  return sources;
}

/**
 * Describes the images in a document through the vision preprocessor, so a
 * text-only main driver can use them as context.
 *
 * Best-effort throughout: a document that fails to load, an attachment that
 * cannot be resolved or a single failed description never fails the run --
 * they are logged and skipped, and the text answer proceeds either with
 * fewer images described or with none (docs/adr/ADR-012-vision-preprocessing.md).
 */
async function describeDocumentImages(input: {
  prisma: PrismaClient;
  storage: ObjectStorage;
  visionPreprocessor: VisionPreprocessor;
  workspaceId: string;
  documentId: string;
  correlationId: string;
  logger: { info: (message: string, context?: Record<string, unknown>) => void };
  maxImages: number;
}): Promise<AiMessage | null> {
  const { prisma, storage, visionPreprocessor, workspaceId, documentId, correlationId, logger, maxImages } = input;

  const content = await prisma.documentContent.findUnique({
    where: { documentId },
    select: { proseMirrorJson: true },
  });
  const sources = collectImageSources(content?.proseMirrorJson as ProseMirrorNode | null);
  if (sources.length === 0) return null;

  const truncated = sources.slice(0, maxImages);
  if (sources.length > truncated.length) {
    logger.info('Describing only the first images on the page', {
      documentId,
      total: sources.length,
      described: truncated.length,
    });
  }

  const descriptions: string[] = [];
  for (const src of truncated) {
    const attachmentId = ATTACHMENT_DOWNLOAD_PATH.exec(src)?.[1];
    if (attachmentId === undefined) continue;

    // Scoped to the run's own workspace and document: a src attribute is part
    // of stored document JSON, not user input, but this keeps a stale or
    // forged reference from reaching another workspace's attachment.
    const attachment = await prisma.attachment.findFirst({
      where: { id: attachmentId, workspaceId, documentId, deletedAt: null },
    });
    if (attachment === null || !attachment.mimeType.startsWith('image/')) continue;

    try {
      const stream = await storage.getObject({ key: attachment.storageKey });
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      const description = await visionPreprocessor.describeImage({
        data: Buffer.concat(chunks),
        mimeType: attachment.mimeType,
        label: attachment.filename,
        correlationId,
        timeoutMs: 20_000,
      });
      if (description.length > 0) {
        descriptions.push(`${attachment.filename}: ${description}`);
      }
    } catch (error) {
      logger.info('Skipping an image that could not be described', {
        documentId,
        attachmentId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (descriptions.length === 0) return null;
  return {
    role: 'system',
    content:
      'Image context from the current page, described by a separate vision model -- ' +
      "you cannot see these images directly, only this description:\n\n" +
      descriptions.map((description, index) => `${index + 1}. ${description}`).join('\n'),
  };
}

/**
 * Chooses the vision companion model: a conversation's explicit override wins
 * ('off' disables it outright), otherwise the model row's admin-configured
 * companion, otherwise `null` (fall through to the deployment default).
 */
function resolveVisionCompanionSlug(
  conversationOverride: string | null,
  modelRowCompanion: string | null,
): string | 'off' | null {
  if (conversationOverride === 'off') return 'off';
  if (conversationOverride !== null) return conversationOverride;
  return modelRowCompanion;
}

/** Wire shape a tool call takes on an assistant message, matching what the provider round-trips. */
function toWireToolCalls(
  toolCalls: readonly AiToolCall[],
): { id: string; type: 'function'; function: { name: string; arguments: string } }[] {
  return toolCalls.map((call) => ({
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: call.argumentsJson },
  }));
}

interface TurnResult {
  text: string;
  toolCalls: AiToolCall[];
  usage: AiUsage | null;
  failure: { code: string; message: string } | null;
  /**
   * Why the provider stopped. `'length'` means the output cap ended the turn,
   * which is the one case a finished-looking turn must never be mistaken for:
   * the text stops mid-sentence and a tool call stops mid-JSON.
   */
  finishReason: AiGenerateResult['finishReason'];
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
  const { prisma, provider, bus, storage } = dependencies;
  let loggedMissingServiceTokenWarning = false;

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
    if (run.status === 'RUNNING') {
      const lastSign = run.heartbeatAt ?? run.startedAt ?? run.createdAt;
      if (Date.now() - lastSign.getTime() < AI_RUN_HEARTBEAT_STALE_MS) {
        // Another worker is still holding this run: taking over would
        // produce a second answer and, through the tool loop, a second round
        // of writes to whatever it touched.
        logger.warn('Skipping AI run: another worker still holds it', { runId: run.id });
        return;
      }
      // The heartbeat went stale: the previous worker died mid-run (crash,
      // deploy restart, stalled job) without a chance to close this out
      // itself. Closing it here, rather than resuming it, is what keeps a
      // resend from ever answering twice or writing twice (docs/adr/ADR-017).
      const closed = await prisma.aiRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: { status: 'FAILED', errorCode: 'ai_run_abandoned', finishedAt: new Date() },
      });
      if (closed.count === 1) {
        await bus.publish({
          type: 'ai.run.failed',
          workspaceId: run.workspaceId,
          correlationId: payload.correlationId,
          emittedAt: new Date().toISOString(),
          payload: {
            runId: run.id,
            status: 'failed',
            errorCode: 'ai_run_abandoned',
            reason: 'The previous execution of this run stopped without finishing',
          },
        });
      }
      logger.warn('Closed out an abandoned AI run', { runId: run.id });
      return;
    }
    if (run.status !== 'PENDING') {
      // Idempotency: a retried job must not produce a second answer.
      logger.info('Skipping AI run: already processed', { runId: run.id, status: run.status });
      return;
    }

    const settings = await dependencies.settings();
    if (!settings['ai.enabled']) {
      await prisma.aiRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', errorCode: 'ai_provider_unavailable', finishedAt: new Date() },
      });
      await bus.publish({
        type: 'ai.run.failed',
        workspaceId: run.workspaceId,
        correlationId: payload.correlationId,
        emittedAt: new Date().toISOString(),
        payload: {
          runId: run.id,
          status: 'failed',
          errorCode: 'ai_provider_unavailable',
          reason: 'AI is disabled via the ai.enabled setting',
        },
      });
      logger.warn('AI run failed: AI is disabled', { runId: run.id });
      return;
    }

    let modelRow = await dependencies.modelRegistry(run.model);
    if (modelRow === null) {
      // An old run (or the mock/test provider's fixed model, which
      // deliberately has no registry row) may reference a slug the registry
      // does not know. Provider defaults keep the run working: no tools, no
      // vision companion, no reasoning control.
      logger.warn('AI run references a model outside the registry; using provider defaults', {
        runId: run.id,
        model: run.model,
      });
      modelRow = {
        id: '',
        slug: run.model,
        provider: run.provider,
        contextWindowTokens: provider.capabilities.contextWindowTokens,
        maxOutputTokens: null,
        supportsVision: false,
        supportsTools: false,
        reasoningLevels: ['NONE'],
        visionCompanionSlug: null,
      };
    }

    const conversation =
      run.conversationId === null
        ? null
        : await prisma.aiConversation.findUnique({ where: { id: run.conversationId } });

    // --- Tool availability ---------------------------------------------------
    // Decided before the message list because the system prompt has to tell the
    // model whether it can fetch the open page itself or has to say it cannot.
    const wantsTools = settings['ai.toolsEnabled'] && modelRow.supportsTools && run.conversationId !== null;
    if (wantsTools && dependencies.toolRunnerFactory === null && !loggedMissingServiceTokenWarning) {
      logger.warn('Tool calling is unavailable: SERVICE_TOKEN_SECRET is not configured');
      loggedMissingServiceTokenWarning = true;
    }
    const toolsEnabled = wantsTools && dependencies.toolRunnerFactory !== null;

    // --- Message list -------------------------------------------------------
    let baseMessages: AiMessage[];
    let restMessages: AiMessage[];
    if (run.conversationId !== null) {
      const systemPromptResult = await buildSystemPrompt({
        prisma,
        workspaceId: run.workspaceId,
        basePrompt: settings['ai.systemPrompt'],
        maxRuleChars: MAX_RULE_CHARS,
        documentId: run.documentId,
        databaseViewId: run.databaseViewId,
        toolsAvailable: toolsEnabled,
        includePageContent: settings['ai.pageContextEnabled'],
        pageContentMaxChars: settings['ai.pageContextMaxChars'],
        logger,
      });

      // Counts only, never the prompt itself: "the AI does not know my page" is
      // otherwise impossible to tell apart from "the model ignored the pointer".
      logger.info('System prompt built for run', {
        runId: run.id,
        alwaysRuleCount: systemPromptResult.alwaysRuleCount,
        onDemandRuleCount: systemPromptResult.onDemandRuleCount,
        ruleBudgetTruncated: systemPromptResult.truncated,
        openPageIncluded: systemPromptResult.openPageIncluded,
        toolsEnabled,
      });

      await compactIfNeeded({
        prisma,
        provider,
        bus,
        conversationId: run.conversationId,
        workspaceId: run.workspaceId,
        contextWindowTokens: modelRow.contextWindowTokens,
        reservedOutputTokens: settings['ai.maxOutputTokens'],
        systemPromptTokens: estimateTokens(systemPromptResult.prompt),
        thresholdPercent: settings['ai.compactionThresholdPercent'],
        keepRecentMessages: settings['ai.compactionKeepRecentMessages'],
        summaryModel: settings['ai.compactionModelSlug'] ?? run.model,
        correlationId: payload.correlationId,
        logger,
      });

      const activeMessages = await prisma.aiConversationMessage.findMany({
        where: { conversationId: run.conversationId, supersededAt: null },
        orderBy: { createdAt: 'asc' },
      });

      baseMessages = [{ role: 'system', content: systemPromptResult.prompt }];
      restMessages = activeMessages.map((message) => ({
        role: CONVERSATION_ROLE_TO_LOWER[message.role],
        content: message.content,
        toolCallId: message.toolCallId ?? undefined,
        toolName: message.toolName ?? undefined,
        toolCalls: message.toolCalls ?? undefined,
      }));
    } else {
      restMessages = aiMessageSchema.array().parse(run.messages);
      baseMessages =
        settings['ai.systemPrompt'].length > 0
          ? [{ role: 'system', content: settings['ai.systemPrompt'] }]
          : [];
    }

    // --- Vision preprocessing ------------------------------------------------
    const companionSlug = resolveVisionCompanionSlug(
      conversation?.visionCompanionSlug ?? null,
      modelRow.visionCompanionSlug,
    );
    let visionPreprocessor: VisionPreprocessor | null = null;
    if (!settings['ai.visionEnabled']) {
      // Vision preprocessing globally disabled.
    } else if (modelRow.supportsVision) {
      // This is the user-visible payoff of the registry: a vision model no
      // longer pays for a companion call.
      logger.info('Skipping vision preprocessing: the main model sees images itself', {
        runId: run.id,
        model: modelRow.slug,
      });
    } else if (companionSlug === 'off') {
      // Explicitly disabled for this conversation.
    } else {
      visionPreprocessor = dependencies.visionPreprocessorFor(companionSlug);
    }

    let imageContext: AiMessage | null = null;
    if (run.documentId !== null && visionPreprocessor !== null) {
      imageContext = await describeDocumentImages({
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
      });
    }

    let providerMessages: AiMessage[] =
      imageContext === null ? [...baseMessages, ...restMessages] : [...baseMessages, imageContext, ...restMessages];

    // Derived once, ahead of the tool runner: a tool call needs its own
    // timeout before the run's clocks are otherwise started below.
    const timeouts = deriveAiRunTimeouts(settings);

    // --- Tools ---------------------------------------------------------------
    const runner: ToolRunner | null = toolsEnabled
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

    const runDeadline = Date.now() + timeouts.runBudgetMs;
    const runController = new AbortController();
    /** Why `runController` aborted; disambiguates the `catch` below (`null` until it fires). */
    let abortReason: 'run_budget' | 'turn_timeout' | 'cancelled' | null = null;
    const runTimer = setTimeout(() => {
      abortReason ??= 'run_budget';
      runController.abort();
    }, timeouts.runBudgetMs);

    // A heartbeat write does two things at once: it renews the row's
    // heartbeat, and `count === 0` reports that the row is no longer RUNNING
    // -- cancelled through the API, or reaped by maintenance -- which is how
    // `POST /cancel` reaches this loop without a second channel.
    const beat = async (): Promise<void> => {
      const touched = await prisma.aiRun.updateMany({
        where: { id: run.id, status: 'RUNNING' },
        data: { heartbeatAt: new Date() },
      });
      if (touched.count === 0) {
        abortReason ??= 'cancelled';
        runController.abort();
      }
    };
    const heartbeat = setInterval(() => {
      void beat().catch((error: unknown) => {
        logger.warn('Heartbeat failed', {
          runId: run.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    }, timeouts.heartbeatIntervalMs);
    let sequence = 0;

    // A `const` arrow function (rather than a hoisted function declaration)
    // keeps TypeScript's null-narrowing of `run` from the guards above intact
    // inside this closure.
    const streamOneTurn = async (messages: readonly AiMessage[]): Promise<TurnResult> => {
      let text = '';
      let toolCalls: AiToolCall[] = [];
      let usage: AiUsage | null = null;
      let failure: { code: string; message: string } | null = null;
      let finishReason: AiGenerateResult['finishReason'] = 'stop';

      // Its own controller, chained to the run's: a turn that overruns
      // `turnTimeoutMs` aborts only itself, while an abort of the whole run
      // (budget, cancellation) still has to reach whichever turn is in flight.
      const turnController = new AbortController();
      const onRunAbort = (): void => turnController.abort();
      runController.signal.addEventListener('abort', onRunAbort, { once: true });
      const turnTimer = setTimeout(() => {
        abortReason ??= 'turn_timeout';
        turnController.abort();
      }, timeouts.turnTimeoutMs);

      try {
        for await (const event of provider.stream({
          messages,
          model: run.model,
          correlationId: payload.correlationId,
          signal: turnController.signal,
          timeoutMs: timeouts.turnTimeoutMs,
          maxOutputTokens,
          tools: runner?.definitions,
          toolChoice: toolsEnabled ? 'auto' : undefined,
          reasoning: { effort: REASONING_LEVEL_TO_LOWER[run.reasoningLevel] },
        })) {
          switch (event.type) {
            case 'delta': {
              text += event.text;
              sequence += 1;
              await bus.publish({
                type: 'ai.run.progress',
                workspaceId: run.workspaceId,
                correlationId: payload.correlationId,
                emittedAt: new Date().toISOString(),
                payload: { runId: run.id, status: 'running', delta: event.text, sequence },
              });
              break;
            }
            case 'tool_calls':
              toolCalls = [...event.toolCalls];
              break;
            case 'usage':
              usage = event.usage;
              break;
            case 'error':
              failure = { code: event.code, message: event.message };
              break;
            case 'done':
              finishReason = event.finishReason;
              break;
            case 'start':
            default:
              break;
          }
        }
      } finally {
        clearTimeout(turnTimer);
        runController.signal.removeEventListener('abort', onRunAbort);
      }

      return { text, toolCalls, usage, failure, finishReason };
    };

    let text = '';
    let usage: AiUsage | null = null;
    let failure: { code: string; message: string } | null = null;
    let toolIterations = 0;
    let spentMicroUsd = 0;
    /** Text of earlier turns that were cut off at the output cap and picked up again. */
    let carriedText = '';
    let truncationRetries = 0;
    const maxIterations = toolsEnabled ? settings['ai.maxToolIterations'] : 0;
    const budgetMicroUsd = settings['ai.budgetMicroUsdPerRun'];

    try {
      while (true) {
        if (Date.now() > runDeadline) {
          failure = {
            code: 'ai_timeout',
            message: `AI run exceeded its budget of ${timeouts.runBudgetMs}ms`,
          };
          break;
        }
        const turn = await streamOneTurn(providerMessages);

        if (turn.usage !== null) {
          usage =
            usage === null
              ? { ...turn.usage }
              : {
                  inputTokens: usage.inputTokens + turn.usage.inputTokens,
                  outputTokens: usage.outputTokens + turn.usage.outputTokens,
                  cachedInputTokens: usage.cachedInputTokens + turn.usage.cachedInputTokens,
                  provider: turn.usage.provider,
                  model: turn.usage.model,
                  providerCostMicroUsd:
                    usage.providerCostMicroUsd === null && turn.usage.providerCostMicroUsd === null
                      ? null
                      : (usage.providerCostMicroUsd ?? 0) + (turn.usage.providerCostMicroUsd ?? 0),
                  durationMs: usage.durationMs + turn.usage.durationMs,
                };
          if (turn.usage.providerCostMicroUsd !== null) spentMicroUsd += turn.usage.providerCostMicroUsd;
        }

        if (turn.failure !== null) {
          failure = turn.failure;
          text = turn.text.length > 0 ? carriedText + turn.text : text;
          break;
        }

        if (turn.finishReason === 'length') {
          // The output cap ended this turn, not the model. Nothing here is a
          // finished answer: the text stops mid-sentence, and a tool call stops
          // mid-JSON and can never be executed. Treating this like a normal
          // turn is what let a run announce a write, write nothing and still
          // count as completed.
          const truncatedToolCall = turn.toolCalls.length > 0;
          for (const call of turn.toolCalls) {
            await bus.publish({
              type: 'ai.run.tool_call',
              workspaceId: run.workspaceId,
              correlationId: payload.correlationId,
              emittedAt: new Date().toISOString(),
              payload: {
                runId: run.id,
                iteration: toolIterations,
                toolName: call.name.length > 0 ? call.name : 'unbekannt',
                status: 'failed',
              },
            });
          }

          truncationRetries += 1;
          if (truncationRetries > MAX_TRUNCATION_RETRIES) {
            failure = {
              code: 'ai_response_truncated',
              message: `The answer hit the output limit of ${maxOutputTokens} tokens more than ${MAX_TRUNCATION_RETRIES} times`,
            };
            text = carriedText + turn.text;
            break;
          }
          if (spentMicroUsd >= budgetMicroUsd) {
            failure = {
              code: 'ai_budget_exceeded',
              message: `AI run would exceed its budget of ${budgetMicroUsd} micro-USD`,
            };
            text = carriedText + turn.text;
            break;
          }

          logger.info('Picking up an answer that hit the output limit', {
            runId: run.id,
            attempt: truncationRetries,
            maxOutputTokens,
            truncatedToolCall,
          });

          // The partial turn goes back into the context either way, so the
          // model can see where it stopped. Only a truncated *text* answer is
          // carried into the result, though: a retried tool call writes its
          // preamble again, and keeping both would duplicate it in the answer.
          providerMessages = [
            ...providerMessages,
            ...(turn.text.length > 0 ? [{ role: 'assistant' as const, content: turn.text }] : []),
            {
              role: 'user' as const,
              content: truncatedToolCall ? TRUNCATION_TOOL_RETRY_PROMPT : TRUNCATION_CONTINUE_PROMPT,
            },
          ];
          if (!truncatedToolCall) carriedText += turn.text;
          continue;
        }

        text = carriedText + turn.text;
        if (turn.toolCalls.length === 0) break;

        // A call the provider never finished assembling (no id, no name) cannot
        // be executed, and persisting it would produce an assistant message the
        // adapter has to drop again on the next request. Report it instead of
        // dropping it in silence.
        const runnableToolCalls = turn.toolCalls.filter(
          (call) => call.id.length > 0 && call.name.length > 0,
        );
        for (const call of turn.toolCalls) {
          if (runnableToolCalls.includes(call)) continue;
          await bus.publish({
            type: 'ai.run.tool_call',
            workspaceId: run.workspaceId,
            correlationId: payload.correlationId,
            emittedAt: new Date().toISOString(),
            payload: {
              runId: run.id,
              iteration: toolIterations,
              toolName: call.name.length > 0 ? call.name : 'unbekannt',
              status: 'failed',
            },
          });
          logger.warn('Discarding a tool call the provider did not deliver completely', {
            runId: run.id,
            toolName: call.name,
          });
        }
        if (runnableToolCalls.length === 0) {
          failure = {
            code: 'ai_tool_call_invalid',
            message: 'The model requested a tool call the provider did not deliver completely',
          };
          break;
        }

        toolIterations += 1;
        if (toolIterations > maxIterations) {
          failure = {
            code: 'ai_tool_limit_exceeded',
            message: `Reached the tool iteration limit of ${maxIterations}`,
          };
          break;
        }
        if (spentMicroUsd >= budgetMicroUsd) {
          failure = {
            code: 'ai_budget_exceeded',
            message: `AI run would exceed its budget of ${budgetMicroUsd} micro-USD`,
          };
          break;
        }

        // Tool calls run sequentially, never in parallel: two mutating calls to
        // the same document in flight at once is exactly the race we do not
        // want, and the ordering also keeps the transcript readable.
        const wireToolCalls = toWireToolCalls(runnableToolCalls);
        // The transcript keeps the whole assistant turn including anything
        // carried over from a continued answer; the wire message repeats only
        // this turn's text, because the earlier part is already in the context.
        await prisma.aiConversationMessage.create({
          data: {
            conversationId: run.conversationId!,
            role: 'ASSISTANT',
            content: text,
            toolCalls: wireToolCalls as unknown as Prisma.InputJsonValue,
            runId: run.id,
            estimatedTokens: estimateMessageTokens({ role: 'assistant', content: text }),
          },
        });
        carriedText = '';
        let nextMessages: AiMessage[] = [
          ...providerMessages,
          { role: 'assistant', content: turn.text, toolCalls: wireToolCalls },
        ];

        for (const call of runnableToolCalls) {
          if (Date.now() > runDeadline) {
            failure = {
              code: 'ai_timeout',
              message: `AI run exceeded its budget of ${timeouts.runBudgetMs}ms`,
            };
            break;
          }
          await bus.publish({
            type: 'ai.run.tool_call',
            workspaceId: run.workspaceId,
            correlationId: payload.correlationId,
            emittedAt: new Date().toISOString(),
            payload: { runId: run.id, iteration: toolIterations, toolName: call.name, status: 'started' },
          });

          const result = await runner!.run({
            name: call.name,
            argumentsJson: call.argumentsJson,
            correlationId: payload.correlationId,
          });

          await prisma.aiConversationMessage.create({
            data: {
              conversationId: run.conversationId!,
              role: 'TOOL',
              content: result.text,
              toolCallId: call.id,
              toolName: call.name,
              runId: run.id,
              estimatedTokens: estimateMessageTokens({ role: 'tool', content: result.text }),
            },
          });

          await bus.publish({
            type: 'ai.run.tool_call',
            workspaceId: run.workspaceId,
            correlationId: payload.correlationId,
            emittedAt: new Date().toISOString(),
            payload: {
              runId: run.id,
              iteration: toolIterations,
              toolName: call.name,
              status: result.isError ? 'failed' : 'succeeded',
            },
          });

          nextMessages = [
            ...nextMessages,
            { role: 'tool', content: result.text, toolCallId: call.id, toolName: call.name },
          ];
        }
        if (failure !== null) break;

        providerMessages = nextMessages;
      }
    } catch (error) {
      failure =
        abortReason === 'cancelled'
          ? { code: 'ai_cancelled', message: 'The run was cancelled' }
          : abortReason !== null
            ? {
                code: 'ai_timeout',
                message:
                  abortReason === 'turn_timeout'
                    ? `A single model answer exceeded ${timeouts.turnTimeoutMs}ms`
                    : `The run exceeded its budget of ${timeouts.runBudgetMs}ms`,
              }
            : {
                code: 'ai_provider_unavailable',
                message: error instanceof Error ? error.message : String(error),
              };
    } finally {
      clearTimeout(runTimer);
      clearInterval(heartbeat);
    }

    if (failure !== null) {
      const terminalStatus: 'CANCELLED' | 'TIMED_OUT' | 'FAILED' =
        failure.code === 'ai_cancelled' ? 'CANCELLED' : failure.code === 'ai_timeout' ? 'TIMED_OUT' : 'FAILED';
      // A status-filtered write, not a blind `update`: the row may already
      // carry a terminal status set by `POST /cancel` or by the maintenance
      // reaper while this loop was still unwinding, and that status must win.
      const written = await prisma.aiRun.updateMany({
        where: { id: run.id, status: { in: ['PENDING', 'RUNNING'] } },
        data: {
          status: terminalStatus,
          errorCode: failure.code,
          finishedAt: new Date(),
          resultText: text.length > 0 ? text : null,
          usage: usage === null ? Prisma.JsonNull : (usage as unknown as Prisma.InputJsonObject),
          toolIterations,
        },
      });
      if (written.count === 0) {
        logger.warn('AI run already ended elsewhere; discarding this result', { runId: run.id });
        return;
      }
      await bus.publish({
        type: 'ai.run.failed',
        workspaceId: run.workspaceId,
        correlationId: payload.correlationId,
        emittedAt: new Date().toISOString(),
        payload: {
          runId: run.id,
          status: terminalStatus === 'CANCELLED' ? 'cancelled' : terminalStatus === 'TIMED_OUT' ? 'timed_out' : 'failed',
          errorCode: failure.code,
          reason: failure.message,
        },
      });
      logger.warn('AI run failed', { runId: run.id, code: failure.code });
      return;
    }

    // Same status-filtered write as above: a run that was cancelled or reaped
    // while its final answer was still streaming must not be resurrected as
    // COMPLETED just because the stream itself finished cleanly.
    const written = await prisma.aiRun.updateMany({
      where: { id: run.id, status: { in: ['PENDING', 'RUNNING'] } },
      data: {
        status: 'COMPLETED',
        resultText: text,
        usage: usage === null ? Prisma.JsonNull : (usage as unknown as Prisma.InputJsonObject),
        finishedAt: new Date(),
        toolIterations,
      },
    });
    if (written.count === 0) {
      logger.warn('AI run already ended elsewhere; discarding a completed result', { runId: run.id });
      return;
    }

    if (run.conversationId !== null) {
      // Only the final assistant text becomes `run.resultText` and the
      // `ai.run.completed` payload; intermediate tool-calling turns were
      // already persisted above as the loop ran. The final answer still needs
      // its own row, though -- otherwise the next user message would build its
      // context from a transcript that is silently missing the assistant's
      // actual reply.
      const finalMessage = await prisma.aiConversationMessage.create({
        data: {
          conversationId: run.conversationId,
          role: 'ASSISTANT',
          content: text,
          runId: run.id,
          estimatedTokens: estimateMessageTokens({ role: 'assistant', content: text }),
        },
      });
      await prisma.aiConversation.update({
        where: { id: run.conversationId },
        data: { lastMessageAt: new Date(), estimatedTokens: { increment: finalMessage.estimatedTokens } },
      });
    }

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
      toolIterations,
    });
  };
}
