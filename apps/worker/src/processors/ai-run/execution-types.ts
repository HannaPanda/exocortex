import { type AiProvider, type RoutingEndpoint } from '@exocortex/ai';
import {
  type AiMessage,
  type AiUsage,
  type deriveAiRunTimeouts,
  type ProviderRoutingOverride,
  type QUEUE_NAMES,
} from '@exocortex/contracts';
import { type AiRun, type PrismaClient } from '@exocortex/database';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';

import { type ToolContext, type ToolRunner } from '../../tool-runner';

import { type RunFailure } from './contract';
import { type RunTimeline } from './timeline';

/** What the turn loop in `execution.ts` is handed, and what it hands back. */

type AiJob = JobContext<typeof QUEUE_NAMES.ai>;
type RunTimeouts = ReturnType<typeof deriveAiRunTimeouts>;

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
  /** The agent profile's routing keys (issue #143), sent with every request. */
  preferences: ProviderRoutingOverride | null;
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
  /** Where each turn and tool call is recorded for the run inspector (issue #145). */
  timeline: RunTimeline;
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
