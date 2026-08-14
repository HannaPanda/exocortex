import { type AiProvider, type VisionPreprocessor } from '@exocortex/ai';
import { estimateTokens } from '@exocortex/ai';
import {
  type AiMessage,
  aiMessageSchema,
  type QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import {
  type AiConversationRole as AiConversationRolePrisma,
  type AiRun,
  type PrismaClient,
} from '@exocortex/database';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';

import { compactIfNeeded } from '../../compaction';
import { buildSystemPrompt } from '../../system-prompt';

import { type ResolvedModelRow } from './contract';

type AiJob = JobContext<typeof QUEUE_NAMES.ai>;

/** Hard cap on how many characters of ALWAYS rule pages the system prompt may carry. Not admin-configurable. */
const MAX_RULE_CHARS = 20_000;

const CONVERSATION_ROLE_TO_LOWER: Record<AiConversationRolePrisma, AiMessage['role']> = {
  SYSTEM: 'system',
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
};

/**
 * The model's registry row, or provider defaults when it has none.
 *
 * An old run (or the mock/test provider's fixed model, which deliberately has
 * no registry row) may reference a slug the registry does not know. Provider
 * defaults keep the run working: no tools, no vision companion, no reasoning
 * control.
 */
export async function resolveModelRow(input: {
  modelRegistry: (slug: string) => Promise<ResolvedModelRow | null>;
  provider: AiProvider;
  run: AiRun;
  logger: AiJob['logger'];
}): Promise<ResolvedModelRow> {
  const known = await input.modelRegistry(input.run.model);
  if (known !== null) return known;

  input.logger.warn('AI run references a model outside the registry; using provider defaults', {
    runId: input.run.id,
    model: input.run.model,
  });
  return {
    id: '',
    slug: input.run.model,
    provider: input.run.provider,
    contextWindowTokens: input.provider.capabilities.contextWindowTokens,
    maxOutputTokens: null,
    supportsVision: false,
    supportsTools: false,
    reasoningLevels: ['NONE'],
    visionCompanionSlug: null,
  };
}

/**
 * The prompt the run starts from: a system message plus the conversation so far.
 *
 * A run without a conversation carries its own message list instead, which is
 * the shape the one-shot endpoints use.
 */
export async function buildRunMessages(input: {
  prisma: PrismaClient;
  provider: AiProvider;
  bus: RedisEventBus;
  run: AiRun;
  settings: Settings;
  context: {
    toolsEnabled: boolean;
    contextWindowTokens: number;
    payload: AiJob['payload'];
    logger: AiJob['logger'];
  };
}): Promise<{ base: AiMessage[]; rest: AiMessage[] }> {
  const { prisma, provider, bus, run, settings } = input;
  const { toolsEnabled, contextWindowTokens, payload, logger } = input.context;

  if (run.conversationId === null) {
    return {
      base:
        settings['ai.systemPrompt'].length > 0
          ? [{ role: 'system', content: settings['ai.systemPrompt'] }]
          : [],
      rest: aiMessageSchema.array().parse(run.messages),
    };
  }

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
    runId: run.id,
    conversationId: run.conversationId,
    workspaceId: run.workspaceId,
    contextWindowTokens,
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

  return {
    base: [{ role: 'system', content: systemPromptResult.prompt }],
    rest: activeMessages.map((message) => ({
      role: CONVERSATION_ROLE_TO_LOWER[message.role],
      content: message.content,
      toolCallId: message.toolCallId ?? undefined,
      toolName: message.toolName ?? undefined,
      toolCalls: message.toolCalls ?? undefined,
    })),
  };
}

/**
 * Chooses the vision companion model: a conversation's explicit override wins
 * ('off' disables it outright), otherwise the model row's admin-configured
 * companion, otherwise `null` (fall through to the deployment default).
 */
export function resolveVisionCompanionSlug(
  conversationOverride: string | null,
  modelRowCompanion: string | null,
): string | 'off' | null {
  if (conversationOverride === 'off') return 'off';
  if (conversationOverride !== null) return conversationOverride;
  return modelRowCompanion;
}

/**
 * The preprocessor that describes the open page's images, or `null` when none
 * should run: vision switched off globally, a main model that sees images
 * itself, or a conversation that turned the companion off.
 */
export function resolveVisionPreprocessor(input: {
  settings: Settings;
  modelRow: ResolvedModelRow;
  conversationCompanionSlug: string | null;
  visionPreprocessorFor: (modelSlug: string | null) => VisionPreprocessor | null;
  run: AiRun;
  logger: AiJob['logger'];
}): VisionPreprocessor | null {
  if (!input.settings['ai.visionEnabled']) return null;
  if (input.modelRow.supportsVision) {
    // This is the user-visible payoff of the registry: a vision model no
    // longer pays for a companion call.
    input.logger.info('Skipping vision preprocessing: the main model sees images itself', {
      runId: input.run.id,
      model: input.modelRow.slug,
    });
    return null;
  }
  const companionSlug = resolveVisionCompanionSlug(
    input.conversationCompanionSlug,
    input.modelRow.visionCompanionSlug,
  );
  if (companionSlug === 'off') return null;
  return input.visionPreprocessorFor(companionSlug);
}
