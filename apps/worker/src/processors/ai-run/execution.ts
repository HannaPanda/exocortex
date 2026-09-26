import {
  AI_NO_ELIGIBLE_PROVIDER,
  type AiProvider,
  type AiRoutingRequirements,
  type AiToolCall,
  couldCompactionHelp,
  estimateConversationTokens,
  estimateMessageTokens,
  planRoute,
  type RoutePlan,
  type RoutingEndpoint,
} from '@exocortex/ai';
import {
  AI_RUN_PHASE_MIN_INTERVAL_MS,
  type AiMessage,
  type AiRunDiagnosis,
  type AiRunPhase,
  type AiUsage,
  type deriveAiRunTimeouts,
  type QUEUE_NAMES,
} from '@exocortex/contracts';
import { type AiRun, type Prisma, type PrismaClient } from '@exocortex/database';
import { withSpan } from '@exocortex/logger';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';

import { runTimeoutDiagnosis } from '../../run-timeout';
import { toolLoopDiagnosis } from '../../tool-ledger';
import { type ToolContext, type ToolRunner } from '../../tool-runner';

import { addUsage, type RunFailure, type TurnResult } from './contract';
import { REASONING_LEVEL_TO_LOWER, toolCallTarget, toWireToolCalls } from './wire';

type AiJob = JobContext<typeof QUEUE_NAMES.ai>;
type RunTimeouts = ReturnType<typeof deriveAiRunTimeouts>;

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

/** Everything the turn loop needs to decide who may serve a request (ADR-032). */
export interface RunRoutingInput {
  endpoints: readonly RoutingEndpoint[];
  /** The model an alias resolves to, for noticing that it moved. `null` for an ordinary model. */
  aliasTargetSlug: string | null;
  usableSharePercent: number;
  requiresTools: boolean;
  requiresReasoningEffort: boolean;
  /** The smallest this prompt could be made; decides whether compacting is worth trying. */
  floorInputTokens: number;
  /** Compacts to the given budget and returns the rebuilt prompt. `null` when this run cannot compact. */
  compact: ((budgetInputTokens: number) => Promise<AiMessage[]>) | null;
  /** Called when the provider answered as a different model than the alias last resolved to. */
  onAliasDrift: ((actualModel: string) => void) | null;
}

export interface RunExecutionInput {
  prisma: PrismaClient;
  provider: AiProvider;
  bus: RedisEventBus;
  run: AiRun;
  payload: AiJob['payload'];
  logger: AiJob['logger'];
  timeouts: RunTimeouts;
  runner: ToolRunner | null;
  toolsEnabled: boolean;
  maxOutputTokens: number;
  maxToolIterations: number;
  budgetMicroUsd: number;
  messages: AiMessage[];
  routing: RunRoutingInput;
}

/** What the run produced, whether or not it got as far as an answer. */
export interface RunOutcome {
  text: string;
  usage: AiUsage | null;
  failure: RunFailure | null;
  toolIterations: number;
  /** Calls made, where `toolIterations` counts the rounds they arrived in. */
  toolCalls: number;
  /** What the run was offered and what that weighed (issue #121); `null` without tools. */
  toolContext: ToolContext | null;
}

/**
 * Runs the conversation with the provider until it produces an answer, fails,
 * or runs out of budget, and reports what happened.
 *
 * A class rather than a function because the loop carries a dozen pieces of
 * mutable state (the text so far, what earlier truncated turns carried over,
 * the running cost, the abort reason) that the heartbeat, the turn stream and
 * the tool loop all read and write. They used to be locals of one 626-line
 * closure, which is how one function ended up with 81 independent paths.
 */
/** What a call the model made after a blocking checkpoint in the same turn answers. */
const PAUSED_CALL_TEXT =
  'Nicht ausgeführt: der Auftrag wartet auf die Antwort auf deine Rückfrage. Die Antwort setzt ' +
  'die Arbeit in einem neuen Lauf fort.';

class RunExecution {
  private readonly input: RunExecutionInput;
  private readonly runDeadline: number;
  private readonly runController = new AbortController();
  private readonly lastPhasePublishedAt = new Map<AiRunPhase, number>();

  private providerMessages: AiMessage[];
  private text = '';
  /** Text of earlier turns that were cut off at the output cap and picked up again. */
  private carriedText = '';
  /**
   * The answer as far as it has streamed, kept up to date so the heartbeat
   * can persist it. A client that noticed a gap in `ai.run.progress` reloads
   * the run and takes this instead of the text it stitched together from
   * deltas it can no longer trust (issue #6).
   */
  private liveText = '';
  private usage: AiUsage | null = null;
  /** Exchanges with the provider so far; names the turn spans (issue #57). */
  private turns = 0;
  private failure: RunFailure | null = null;
  /**
   * Set when a tool call raised a blocking human checkpoint (issue #140). The
   * run ends after the turn, as completed: it did what it could and now waits
   * on a person, and an answer starts the next run rather than this worker
   * staying open for it.
   */
  private paused = false;
  private toolIterations = 0;
  private spentMicroUsd = 0;
  private truncationRetries = 0;
  private sequence = 0;
  /** Why `runController` aborted; disambiguates the `catch` below (`null` until it fires). */
  private abortReason: 'run_budget' | 'turn_timeout' | 'cancelled' | null = null;
  /**
   * Who may serve the turn that is about to go out (ADR-032). Re-planned before
   * every turn, because a tool result can add fifty thousand tokens to the
   * prompt and put the request beyond the provider that took the last one.
   */
  private routing: AiRoutingRequirements | undefined;
  /** Whether an alias drift was already reported; once per run is enough. */
  private aliasDriftReported = false;
  /**
   * What the turn that is in flight has produced so far, for the timeout
   * diagnosis. A turn that streamed nothing at all and a turn that stopped
   * mid-sentence are two different failures, and only the first one is
   * answered by turning the thinking level down.
   */
  private turnChars = 0;
  private turnSawReasoning = false;

  constructor(input: RunExecutionInput) {
    this.input = input;
    this.providerMessages = [...input.messages];
    this.runDeadline = Date.now() + input.timeouts.runBudgetMs;
  }

  async execute(): Promise<RunOutcome> {
    const { timeouts, logger, run } = this.input;
    const runTimer = setTimeout(() => {
      this.abortReason ??= 'run_budget';
      this.runController.abort();
    }, timeouts.runBudgetMs);
    const heartbeat = setInterval(() => {
      void this.beat().catch((error: unknown) => {
        logger.warn('Heartbeat failed', {
          runId: run.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    }, timeouts.heartbeatIntervalMs);

    try {
      await this.loop();
    } catch (error) {
      this.failure = this.describeAbort(error);
    } finally {
      clearTimeout(runTimer);
      clearInterval(heartbeat);
    }

    return {
      text: this.text,
      usage: this.usage,
      failure: this.failure,
      toolIterations: this.toolIterations,
      toolCalls: this.input.runner?.callCount() ?? 0,
      // Read at the end rather than at the start: a run that opened a domain
      // through `exo_toolbox` was offered more in its last turn than in its
      // first, and the larger number is the one that was paid for.
      toolContext: this.input.runner?.toolContext() ?? null,
    };
  }

  /** One exchange with the provider after another, until something ends the run. */
  private async loop(): Promise<void> {
    while (true) {
      if (Date.now() > this.runDeadline) {
        this.failure = this.timeoutFailure();
        return;
      }

      if (!(await this.prepareRoute())) return;

      const turn = await this.traceTurn();
      this.noteResolvedModel(turn.usage);
      if (turn.usage !== null) {
        this.usage = addUsage(this.usage, turn.usage);
        if (turn.usage.providerCostMicroUsd !== null) {
          this.spentMicroUsd += turn.usage.providerCostMicroUsd;
        }
      }

      if (turn.failure !== null) {
        this.failure = turn.failure;
        if (turn.text.length > 0) this.text = this.carriedText + turn.text;
        return;
      }

      if (turn.finishReason === 'length') {
        if (await this.pickUpTruncatedTurn(turn)) continue;
        return;
      }

      this.text = this.carriedText + turn.text;
      if (turn.toolCalls.length === 0) return;
      if (!(await this.dispatchToolCalls(turn))) return;
    }
  }

  /**
   * Decides who may serve the turn that is about to go out, and says whether
   * the run can go on (ADR-032).
   *
   * The prompt grows between turns -- a tool result is part of the next one --
   * so this is asked again every time rather than once per run. When nothing
   * can serve the request, compaction is tried first, but only when making the
   * prompt smaller would actually put a provider back in reach: a request no
   * provider can serve because it needs tools, or because the answer is capped
   * too high, is not a size problem and summarising it away would cost a model
   * call and a piece of the transcript for nothing.
   */
  private async prepareRoute(): Promise<boolean> {
    const { routing, logger, run } = this.input;

    let plan = this.planFor(this.providerMessages);
    if (!plan.known || plan.allowedProviderKeys.length > 0) {
      this.applyPlan(plan);
      return true;
    }

    if (
      routing.compact !== null &&
      couldCompactionHelp({ plan, floorInputTokens: routing.floorInputTokens })
    ) {
      logger.info('No provider can serve this turn; compacting first', {
        runId: run.id,
        model: run.model,
        largestUsableInputTokens: plan.largestUsableInputTokens,
        floorInputTokens: routing.floorInputTokens,
      });
      this.providerMessages = await routing.compact(plan.largestUsableInputTokens);
      plan = this.planFor(this.providerMessages);
    }

    if (plan.allowedProviderKeys.length === 0) {
      // Refused here rather than upstream: the provider would answer 404 and
      // charge nothing, but it would also take a round trip to say what the
      // registry already knows.
      // Only ever a size problem by the time it gets here: a model whose
      // providers cannot do what the run needs answers `known: false` and goes
      // out unrestricted instead (see `planRoute`).
      this.failure = {
        code: AI_NO_ELIGIBLE_PROVIDER,
        message: 'The request is larger than any provider of this model can serve',
      };
      logger.warn('No eligible provider for this run', {
        runId: run.id,
        model: run.model,
        knownEndpoints: routing.endpoints.length,
        capableEndpoints: plan.capableEndpoints,
        largestUsableInputTokens: plan.largestUsableInputTokens,
      });
      return false;
    }

    this.applyPlan(plan);
    return true;
  }

  private planFor(messages: readonly AiMessage[]): RoutePlan {
    const { routing, maxOutputTokens } = this.input;
    return planRoute({
      endpoints: routing.endpoints,
      inputTokens: estimateConversationTokens(
        messages.map((message) => ({ role: message.role, content: message.content })),
      ),
      reservedOutputTokens: maxOutputTokens,
      usableSharePercent: routing.usableSharePercent,
      requiresTools: routing.requiresTools,
      requiresReasoningEffort: routing.requiresReasoningEffort,
    });
  }

  /** Carries a plan into the next request, and records what it decided. Never content. */
  private applyPlan(plan: RoutePlan): void {
    this.routing = plan.known
      ? {
          allowedProviderKeys: plan.allowedProviderKeys,
          minimumContextTokens: this.input.maxOutputTokens,
        }
      : undefined;
    if (!plan.known) return;
    this.input.logger.debug('Route planned for turn', {
      runId: this.input.run.id,
      model: this.input.run.model,
      turn: this.turns + 1,
      knownEndpoints: this.input.routing.endpoints.length,
      capableEndpoints: plan.capableEndpoints,
      eligibleEndpoints: plan.allowedProviderKeys.length,
    });
  }

  /**
   * Notices that a `latest` alias now answers as a different model.
   *
   * The snapshot the route was planned from describes the old target, so the
   * refresh is asked for immediately rather than waited for: the plan stays
   * valid for this run either way, because both targets are served by
   * providers the allowlist named.
   */
  private noteResolvedModel(usage: AiUsage | null): void {
    const { routing, run, logger } = this.input;
    if (usage === null || routing.aliasTargetSlug === null || this.aliasDriftReported) return;
    if (usage.model === routing.aliasTargetSlug || usage.model === run.model) return;

    this.aliasDriftReported = true;
    logger.info('The alias resolved to a different model than the registry has', {
      runId: run.id,
      model: run.model,
      expected: routing.aliasTargetSlug,
      actual: usage.model,
    });
    routing.onAliasDrift?.(usage.model);
  }

  /**
   * One turn, with a span around it.
   *
   * The span is here rather than inside `streamOneTurn` because a turn is
   * exactly one exchange with the provider, and what is worth recording about
   * it -- how it ended, what it cost, whether it asked for tools -- is only
   * known once it has ended.
   */
  private async traceTurn(): Promise<TurnResult> {
    const { payload, run } = this.input;
    this.turns += 1;
    const index = this.turns;
    return withSpan(
      'ai.turn',
      async (span) => {
        const turn = await this.streamOneTurn(this.providerMessages);
        span.setAttributes({
          'ai.turn.finish_reason': turn.finishReason,
          'ai.turn.tool_calls': turn.toolCalls.length,
          'ai.usage.input_tokens': turn.usage?.inputTokens,
          'ai.usage.output_tokens': turn.usage?.outputTokens,
        });
        if (turn.failure !== null) span.setStatus('error', turn.failure.code);
        return turn;
      },
      {
        correlationId: payload.correlationId,
        attributes: { 'ai.model': run.model, 'ai.turn.index': index, 'ai.run.id': run.id },
      },
    );
  }

  /**
   * Streams one answer from the provider.
   *
   * Its own abort controller, chained to the run's: a turn that overruns
   * `turnTimeoutMs` aborts only itself, while an abort of the whole run
   * (budget, cancellation) still has to reach whichever turn is in flight.
   */
  private async streamOneTurn(messages: readonly AiMessage[]): Promise<TurnResult> {
    const { provider, bus, run, payload, timeouts, runner, toolsEnabled } = this.input;
    let text = '';
    let toolCalls: AiToolCall[] = [];
    let usage: AiUsage | null = null;
    let failure: RunFailure | null = null;
    let finishReason: TurnResult['finishReason'] = 'stop';

    const turnController = new AbortController();
    const onRunAbort = (): void => turnController.abort();
    this.runController.signal.addEventListener('abort', onRunAbort, { once: true });
    const turnTimer = setTimeout(() => {
      this.abortReason ??= 'turn_timeout';
      turnController.abort();
    }, timeouts.turnTimeoutMs);

    // Ends whatever named silence came before it (a compaction, the
    // previous turn's thinking) and says a fresh answer is being asked for.
    await this.publishPhase('generating');
    // What the run's answer is worth right now: everything carried over
    // from a turn that was cut off at the output cap, and nothing else
    // until this turn produces its first delta.
    this.liveText = this.carriedText;
    this.turnChars = 0;
    this.turnSawReasoning = false;

    try {
      for await (const event of provider.stream({
        messages,
        model: run.model,
        correlationId: payload.correlationId,
        signal: turnController.signal,
        timeoutMs: timeouts.turnTimeoutMs,
        maxOutputTokens: this.input.maxOutputTokens,
        tools: runner?.definitions,
        toolChoice: toolsEnabled ? 'auto' : undefined,
        reasoning: { effort: REASONING_LEVEL_TO_LOWER[run.reasoningLevel] },
        routing: this.routing,
      })) {
        switch (event.type) {
          case 'delta': {
            text += event.text;
            this.liveText = this.carriedText + text;
            this.turnChars = text.length;
            this.sequence += 1;
            await bus.publish({
              type: 'ai.run.progress',
              workspaceId: run.workspaceId,
              correlationId: payload.correlationId,
              emittedAt: new Date().toISOString(),
              payload: {
                runId: run.id,
                status: 'running',
                delta: event.text,
                sequence: this.sequence,
              },
            });
            break;
          }
          case 'reasoning':
            // The fragment itself never leaves the provider adapter; only
            // the fact that thinking is going on does.
            this.turnSawReasoning = true;
            await this.publishPhase('reasoning');
            break;
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
      this.runController.signal.removeEventListener('abort', onRunAbort);
    }

    return { text, toolCalls, usage, failure, finishReason };
  }

  /**
   * Handles a turn the output cap ended, and says whether to try again.
   *
   * Nothing in such a turn is a finished answer: the text stops mid-sentence,
   * and a tool call stops mid-JSON and can never be executed. Treating this
   * like a normal turn is what let a run announce a write, write nothing and
   * still count as completed.
   */
  private async pickUpTruncatedTurn(turn: TurnResult): Promise<boolean> {
    const { logger, run, maxOutputTokens, budgetMicroUsd } = this.input;
    const truncatedToolCall = turn.toolCalls.length > 0;
    for (const call of turn.toolCalls) {
      await this.publishToolCall(
        call.name,
        'failed',
        toolCallTarget(call.name, call.argumentsJson),
      );
    }

    this.truncationRetries += 1;
    if (this.truncationRetries > MAX_TRUNCATION_RETRIES) {
      this.failure = {
        code: 'ai_response_truncated',
        message: `The answer hit the output limit of ${maxOutputTokens} tokens more than ${MAX_TRUNCATION_RETRIES} times`,
      };
      this.text = this.carriedText + turn.text;
      return false;
    }
    if (this.spentMicroUsd >= budgetMicroUsd) {
      this.failure = this.budgetFailure();
      this.text = this.carriedText + turn.text;
      return false;
    }

    logger.info('Picking up an answer that hit the output limit', {
      runId: run.id,
      attempt: this.truncationRetries,
      maxOutputTokens,
      truncatedToolCall,
    });

    // The partial turn goes back into the context either way, so the
    // model can see where it stopped. Only a truncated *text* answer is
    // carried into the result, though: a retried tool call writes its
    // preamble again, and keeping both would duplicate it in the answer.
    this.providerMessages = [
      ...this.providerMessages,
      ...(turn.text.length > 0 ? [{ role: 'assistant' as const, content: turn.text }] : []),
      {
        role: 'user' as const,
        content: truncatedToolCall ? TRUNCATION_TOOL_RETRY_PROMPT : TRUNCATION_CONTINUE_PROMPT,
      },
    ];
    if (!truncatedToolCall) this.carriedText += turn.text;
    return true;
  }

  /** Runs the turn's tool calls; `false` when the run must stop afterwards. */
  private async dispatchToolCalls(turn: TurnResult): Promise<boolean> {
    const { prisma, run, maxToolIterations, budgetMicroUsd } = this.input;

    // A call the provider never finished assembling (no id, no name) cannot
    // be executed, and persisting it would produce an assistant message the
    // adapter has to drop again on the next request. Report it instead of
    // dropping it in silence.
    const runnable = turn.toolCalls.filter((call) => call.id.length > 0 && call.name.length > 0);
    await this.reportUndeliveredToolCalls(turn.toolCalls, runnable);
    if (runnable.length === 0) {
      this.failure = {
        code: 'ai_tool_call_invalid',
        message: 'The model requested a tool call the provider did not deliver completely',
      };
      return false;
    }

    this.toolIterations += 1;
    if (this.toolIterations > maxToolIterations) {
      this.failure = {
        code: 'ai_tool_limit_exceeded',
        message: `Reached the tool iteration limit of ${maxToolIterations}`,
        // The limit is the one fact the reader already had (issue #118). What
        // the run actually did with its calls is what decides whether the
        // answer is a higher limit or a different way in, so it is said here.
        diagnosis: toolLoopDiagnosis({
          limit: maxToolIterations,
          tallies: this.input.runner?.tallies() ?? [],
        }),
      };
      return false;
    }
    if (this.spentMicroUsd >= budgetMicroUsd) {
      this.failure = this.budgetFailure();
      return false;
    }

    const wireToolCalls = toWireToolCalls(runnable);
    // The transcript keeps the whole assistant turn including anything
    // carried over from a continued answer; the wire message repeats only
    // this turn's text, because the earlier part is already in the context.
    await prisma.aiConversationMessage.create({
      data: {
        conversationId: run.conversationId!,
        role: 'ASSISTANT',
        content: this.text,
        toolCalls: wireToolCalls as unknown as Prisma.InputJsonValue,
        runId: run.id,
        estimatedTokens: estimateMessageTokens({ role: 'assistant', content: this.text }),
      },
    });
    this.carriedText = '';

    const toolMessages = await this.runToolCalls(runnable);
    if (this.failure !== null) return false;
    if (this.paused) {
      this.input.logger.info('Run paused on a human checkpoint', { runId: run.id });
      return false;
    }

    this.providerMessages = [
      ...this.providerMessages,
      { role: 'assistant', content: turn.text, toolCalls: wireToolCalls },
      ...toolMessages,
    ];
    return true;
  }

  /**
   * Executes the runnable calls one after another.
   *
   * Never in parallel: two mutating calls to the same document in flight at
   * once is exactly the race we do not want, and the ordering also keeps the
   * transcript readable.
   */
  private async runToolCalls(runnable: readonly AiToolCall[]): Promise<AiMessage[]> {
    const { prisma, run, payload, runner } = this.input;
    const messages: AiMessage[] = [];

    for (const call of runnable) {
      if (Date.now() > this.runDeadline) {
        this.failure = this.timeoutFailure();
        return messages;
      }
      // Computed once per call and reused for the `succeeded`/`failed`
      // event below: the arguments (and therefore the target) never
      // change between the two.
      const target = toolCallTarget(call.name, call.argumentsJson);
      await this.publishToolCall(call.name, 'started', target);

      // Whatever the model meant to do after asking waits for the answer too:
      // a write queued behind a request for approval is exactly the write the
      // approval is about (issue #140). Every call still gets its tool
      // message, or the transcript would hold a call without a result.
      const result = this.paused
        ? { text: PAUSED_CALL_TEXT, isError: true, refused: true }
        : await runner!.run({
            name: call.name,
            argumentsJson: call.argumentsJson,
            correlationId: payload.correlationId,
          });
      if (result.pausesRun === true) this.paused = true;

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

      await this.publishToolCall(
        call.name,
        result.refused ? 'refused' : result.isError ? 'failed' : 'succeeded',
        target,
      );
      messages.push({
        role: 'tool',
        content: result.text,
        toolCallId: call.id,
        toolName: call.name,
      });
    }
    return messages;
  }

  private async reportUndeliveredToolCalls(
    all: readonly AiToolCall[],
    runnable: readonly AiToolCall[],
  ): Promise<void> {
    for (const call of all) {
      if (runnable.includes(call)) continue;
      await this.publishToolCall(
        call.name,
        'failed',
        toolCallTarget(call.name, call.argumentsJson),
      );
      this.input.logger.warn('Discarding a tool call the provider did not deliver completely', {
        runId: this.input.run.id,
        toolName: call.name,
      });
    }
  }

  private async publishToolCall(
    toolName: string,
    status: 'started' | 'succeeded' | 'failed' | 'refused',
    target: string | null,
  ): Promise<void> {
    const { bus, run, payload } = this.input;
    await bus.publish({
      type: 'ai.run.tool_call',
      workspaceId: run.workspaceId,
      correlationId: payload.correlationId,
      emittedAt: new Date().toISOString(),
      payload: {
        runId: run.id,
        iteration: this.toolIterations,
        toolName: toolName.length > 0 ? toolName : 'unbekannt',
        status,
        target,
      },
    });
  }

  /**
   * Renews the row's heartbeat, and notices when the run stopped being ours.
   *
   * A heartbeat write does two things at once: `count === 0` reports that the
   * row is no longer RUNNING -- cancelled through the API, or reaped by
   * maintenance -- which is how `POST /cancel` reaches this loop without a
   * second channel.
   */
  private async beat(): Promise<void> {
    const touched = await this.input.prisma.aiRun.updateMany({
      where: { id: this.input.run.id, status: 'RUNNING' },
      data: {
        heartbeatAt: new Date(),
        // Only ever grows while the run is in flight, and the terminal
        // writes overwrite it with the final text either way.
        ...(this.liveText.length > 0 ? { resultText: this.liveText } : {}),
      },
    });
    if (touched.count === 0) {
      this.abortReason ??= 'cancelled';
      this.runController.abort();
    }
  }

  /**
   * Names a phase that produces no text of its own, so a legitimate silence
   * (three minutes of it are allowed by `ai.timeoutMs`) is distinguishable
   * from a stall. Throttled per phase: reasoning arrives as a stream of tiny
   * fragments, and repeating "still thinking" for each one says nothing the
   * first one did not.
   */
  private async publishPhase(phase: AiRunPhase): Promise<void> {
    const { bus, run, payload } = this.input;
    const now = Date.now();
    const previous = this.lastPhasePublishedAt.get(phase);
    if (previous !== undefined && now - previous < AI_RUN_PHASE_MIN_INTERVAL_MS) return;
    this.lastPhasePublishedAt.set(phase, now);
    await bus.publish({
      type: 'ai.run.phase',
      workspaceId: run.workspaceId,
      correlationId: payload.correlationId,
      emittedAt: new Date().toISOString(),
      payload: { runId: run.id, phase },
    });
  }

  /** Turns a thrown abort into the failure it actually was. */
  private describeAbort(error: unknown): RunFailure {
    const { timeouts } = this.input;
    if (this.abortReason === 'cancelled') {
      return { code: 'ai_cancelled', message: 'The run was cancelled' };
    }
    if (this.abortReason === 'turn_timeout') {
      return {
        code: 'ai_timeout',
        message: `A single model answer exceeded ${timeouts.turnTimeoutMs}ms`,
        diagnosis: this.describeTimeout('turn', timeouts.turnTimeoutMs),
      };
    }
    if (this.abortReason === 'run_budget') {
      return {
        code: 'ai_timeout',
        message: `The run exceeded its budget of ${timeouts.runBudgetMs}ms`,
        diagnosis: this.describeTimeout('run', timeouts.runBudgetMs),
      };
    }
    return {
      code: 'ai_provider_unavailable',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private timeoutFailure(): RunFailure {
    return {
      code: 'ai_timeout',
      message: `AI run exceeded its budget of ${this.input.timeouts.runBudgetMs}ms`,
      diagnosis: this.describeTimeout('run', this.input.timeouts.runBudgetMs),
    };
  }

  /**
   * The same thing said to the person: which limit ran out, at which thinking
   * level, and whether any of the answer had arrived by then. Stored on the
   * run and shown in the panel instead of the canned sentence, the way
   * `ai_tool_limit_exceeded` already reads out its tally (ADR-059).
   */
  private describeTimeout(limit: 'turn' | 'run', limitMs: number): AiRunDiagnosis {
    return runTimeoutDiagnosis({
      limit,
      limitMs,
      model: this.input.run.model,
      effort: REASONING_LEVEL_TO_LOWER[this.input.run.reasoningLevel],
      turnChars: this.turnChars,
      sawReasoning: this.turnSawReasoning,
      toolIterations: this.toolIterations,
    });
  }

  private budgetFailure(): RunFailure {
    return {
      code: 'ai_budget_exceeded',
      message: `AI run would exceed its budget of ${this.input.budgetMicroUsd} micro-USD`,
    };
  }
}

/** Runs the conversation with the provider and reports what it produced. */
export async function executeRun(input: RunExecutionInput): Promise<RunOutcome> {
  return new RunExecution(input).execute();
}
