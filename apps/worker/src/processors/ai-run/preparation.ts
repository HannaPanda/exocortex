import {
  type AiProvider,
  estimateTokens,
  isProviderPresetId,
  planRoute,
  restrictEndpoints,
  type RoutingEndpoint,
  type VisionPreprocessor,
} from '@exocortex/ai';
import {
  type AiMessage,
  aiMessageSchema,
  mergeProviderRouting,
  type ProviderRoutingOverride,
  type QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import {
  type AiConversationRole as AiConversationRolePrisma,
  type AiRun,
  type PrismaClient,
  type SearchAdapter,
} from '@exocortex/database';
import { type JobContext, type RedisEventBus } from '@exocortex/queue';

import { compactIfNeeded, estimateFloorInputTokens } from '../../compaction';
import { buildSystemPrompt, type PromptSection } from '../../system-prompt';
import { type ToolImageDescriber } from '../../tool-images';

import {
  chatAttachmentContext,
  loadCarriedFiles,
  loadChatAttachmentsForPrompt,
} from './chat-attachments';
import { carriedFilesContext } from './chat-documents';
import { type ChatImagePixels, type RunPromptMessage } from './chat-images';
import { type ResolvedModelRow } from './contract';
import { type RunTimeline } from './timeline';

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
    inputMicroUsdPerMTok: null,
    outputMicroUsdPerMTok: null,
    endpoints: [],
    aliasTargetSlug: null,
    providerRouting: null,
  };
}

/**
 * The row with its snapshot narrowed to the providers the configuration allows
 * (issue #135, ADR-063).
 *
 * Done once, before the prompt is budgeted: both the budget and every turn's
 * plan are computed from these endpoints, so a provider the configuration
 * excludes can neither be planned for nor make a conversation compact late.
 */
export function withConfiguredEndpoints(
  modelRow: ResolvedModelRow,
  settings: Settings,
  /** An agent profile's keys (issue #143), laid over the model's. */
  profileRouting: ProviderRoutingOverride | null = null,
): ResolvedModelRow {
  const preferences = mergeProviderRouting(
    mergeProviderRouting(settings['ai.providerRouting'], modelRow.providerRouting),
    profileRouting,
  );
  return { ...modelRow, endpoints: restrictEndpoints(modelRow.endpoints, preferences) };
}

/** What the prompt is, and how much room it has (ADR-032). */
export interface BuiltRunMessages {
  base: AiMessage[];
  rest: RunPromptMessage[];
  /**
   * The largest prompt this run may send. Comes from the largest provider that
   * could serve it once the model has an endpoint snapshot, and from the
   * model's own window otherwise. `Infinity` for a run without a conversation,
   * which carries its own message list and cannot be compacted.
   */
  budgetInputTokens: number;
  /** The smallest the prompt could be made; `0` when there is nothing to compact. */
  floorInputTokens: number;
  /** The system prompt part by part, for the run inspector (issue #145). */
  promptSections: PromptSection[];
}

/**
 * How much prompt fits, given who could serve it.
 *
 * With an endpoint snapshot this is the largest provider's usable input, which
 * is the whole point of ADR-032: a 262k provider in the set must not make a
 * conversation compact at 262k while a 1.3M provider is standing right there.
 * Without a snapshot it is the old arithmetic on the model's own window.
 */
function resolveBudgetInputTokens(input: {
  endpoints: readonly RoutingEndpoint[];
  contextWindowTokens: number;
  reservedOutputTokens: number;
  usableSharePercent: number;
  requiresTools: boolean;
  requiresReasoningEffort: boolean;
}): number {
  const plan = planRoute({
    endpoints: input.endpoints,
    inputTokens: 0,
    reservedOutputTokens: input.reservedOutputTokens,
    usableSharePercent: input.usableSharePercent,
    requiresTools: input.requiresTools,
    requiresReasoningEffort: input.requiresReasoningEffort,
  });
  if (plan.known && plan.largestUsableInputTokens > 0) return plan.largestUsableInputTokens;
  return (
    Math.floor((input.contextWindowTokens * input.usableSharePercent) / 100) -
    input.reservedOutputTokens
  );
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
  timeline: RunTimeline;
  /** Chat pictures as pixels for a model that sees them (ADR-097); null reads descriptions. */
  pixels: ChatImagePixels | null;
  context: {
    toolsEnabled: boolean;
    contextWindowTokens: number;
    /** The providers that serve this model, empty when the registry has no snapshot (ADR-032). */
    endpoints: readonly RoutingEndpoint[];
    reservedOutputTokens: number;
    requiresReasoningEffort: boolean;
    /** Both search halves, for a pinned saved query in the system prompt (issue #75). */
    search: { hybrid: SearchAdapter; keyword: SearchAdapter };
    payload: AiJob['payload'];
    logger: AiJob['logger'];
  };
}): Promise<BuiltRunMessages> {
  const { prisma, provider, bus, run, settings } = input;
  const { toolsEnabled, contextWindowTokens, payload, logger } = input.context;

  if (run.conversationId === null) {
    const basePrompt = settings['ai.systemPrompt'];
    return {
      base: basePrompt.length > 0 ? [{ role: 'system', content: basePrompt }] : [],
      rest: aiMessageSchema.array().parse(run.messages),
      budgetInputTokens: Number.POSITIVE_INFINITY,
      floorInputTokens: 0,
      promptSections:
        basePrompt.length > 0
          ? [{ key: 'base_prompt', text: basePrompt, items: null, truncated: false, sources: [] }]
          : [],
    };
  }

  const systemPromptResult = await buildSystemPrompt({
    prisma,
    workspaceId: run.workspaceId,
    basePrompt: settings['ai.systemPrompt'],
    maxRuleChars: MAX_RULE_CHARS,
    documentId: run.documentId,
    userId: run.createdById,
    databaseViewId: run.databaseViewId,
    conversationId: run.conversationId,
    pinnedContextMaxChars: settings['ai.pinnedContextMaxChars'],
    search: input.context.search,
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
    pinnedSourceCount: systemPromptResult.pinnedSourceCount,
    pinnedSourceChars: systemPromptResult.pinnedSourceChars,
    toolsEnabled,
  });

  const systemPromptTokens = estimateTokens(systemPromptResult.prompt);
  const budgetInputTokens = resolveBudgetInputTokens({
    endpoints: input.context.endpoints,
    contextWindowTokens,
    reservedOutputTokens: input.context.reservedOutputTokens,
    usableSharePercent: settings['ai.compactionThresholdPercent'],
    requiresTools: toolsEnabled,
    requiresReasoningEffort: input.context.requiresReasoningEffort,
  });

  const conversationId = run.conversationId;
  await input.timeline.timed(
    () =>
      compactIfNeeded({
        prisma,
        provider,
        bus,
        runId: run.id,
        conversationId,
        workspaceId: run.workspaceId,
        budgetInputTokens,
        systemPromptTokens,
        keepRecentMessages: settings['ai.compactionKeepRecentMessages'],
        summaryModel: settings['ai.compactionModelSlug'] ?? run.model,
        correlationId: payload.correlationId,
        logger,
      }),
    (result) =>
      result.compacted
        ? {
            kind: 'compaction',
            data: { summarizedMessages: result.summarizedMessages, trigger: 'prepare' },
          }
        : null,
  );

  return {
    promptSections: systemPromptResult.sections,
    base: [{ role: 'system', content: systemPromptResult.prompt }],
    rest: await loadConversationMessages(prisma, run.conversationId, run.createdById, input.pixels),
    budgetInputTokens,
    floorInputTokens: await estimateFloorInputTokens({
      prisma,
      conversationId: run.conversationId,
      systemPromptTokens,
      keepRecentMessages: settings['ai.compactionKeepRecentMessages'],
    }),
  };
}

/** The active transcript as provider messages. Reloaded after a compaction, so it is its own function. */
export async function loadConversationMessages(
  prisma: PrismaClient,
  conversationId: string,
  /** The run's requester: whose own uploads its chat files may be (ADR-096). */
  readerId: string,
  /** Reads chat pictures as pixels for a model that sees them (ADR-097); null reads descriptions. */
  pixels: ChatImagePixels | null = null,
): Promise<RunPromptMessage[]> {
  const activeMessages = await prisma.aiConversationMessage.findMany({
    where: { conversationId, supersededAt: null },
    orderBy: { createdAt: 'asc' },
  });
  // Pictures on a message stand right before it, as what the vision model
  // saw (issue #223), or ride on the message itself as pixels (ADR-097); the
  // message's text stays what the person typed.
  const { byMessage, documents, images } = await loadChatAttachmentsForPrompt(
    prisma,
    activeMessages.filter((message) => message.role === 'USER').map((message) => message.id),
    readerId,
    pixels,
  );
  // The files of messages a compaction took in stand after the summary that
  // took them in, the latest one: a summary knows only text (issue #223).
  const carried = carriedFilesContext(await loadCarriedFiles(prisma, conversationId, readerId));
  const lastSummary = activeMessages.findLastIndex((message) => message.isSummary);
  return activeMessages.flatMap((message, index) => {
    const files = byMessage.get(message.id) ?? [];
    const pictures = files.flatMap((file) => {
      const image = images.get(file.id);
      return image === undefined ? [] : [image];
    });
    const context = chatAttachmentContext(
      files,
      new Set(images.keys()),
      documents.get(message.id) ?? [],
    );
    const own: RunPromptMessage = {
      role: CONVERSATION_ROLE_TO_LOWER[message.role],
      content: message.content,
      toolCallId: message.toolCallId ?? undefined,
      toolName: message.toolName ?? undefined,
      toolCalls: message.toolCalls ?? undefined,
      ...(pictures.length > 0 ? { images: pictures } : {}),
    };
    if (index === lastSummary && carried !== null) return [own, carried];
    return context === null ? [own] : [context, own];
  });
}

/**
 * Chooses the vision companion model: a conversation's explicit override wins
 * ('off' disables it outright), otherwise the model row's admin-configured
 * companion, otherwise `null` (fall through to the deployment default).
 */
export function resolveVisionCompanionSlug(
  conversationOverride: string | null,
  modelRowCompanion: string | null,
): string | null {
  if (conversationOverride === 'off') return 'off';
  if (conversationOverride !== null) return conversationOverride;
  return modelRowCompanion;
}

/**
 * Who looks at a picture a tool returned (issue #204), or `null` when nobody
 * may: vision switched off, or a conversation that turned its companion off.
 *
 * The built-in loop's tool results are text (ADR-009), so the picture reaches
 * the model as a description either way. A main model that sees images
 * describes the picture itself, and only a text-only model, or one whose slug
 * OpenRouter does not know, borrows its companion (ADR-012). The open page's
 * pictures and a chat picture are described by the same choice (ADR-102).
 */
export function resolveToolImageDescriber(input: {
  settings: Settings;
  modelRow: ResolvedModelRow;
  conversationCompanionSlug: string | null;
  visionPreprocessorFor: (modelSlug: string | null) => VisionPreprocessor | null;
  correlationId: string;
}): ToolImageDescriber | null {
  return resolveImageDescriber(input)?.describe ?? null;
}

/**
 * `resolveToolImageDescriber`, together with the model it asks: a picture on
 * a chat message keeps the name of whoever described it (issue #223). Null
 * where the slug is, because a companion left to the deployment default has
 * no name here.
 */
export function resolveImageDescriber(input: {
  settings: Settings;
  modelRow: ResolvedModelRow;
  conversationCompanionSlug: string | null;
  visionPreprocessorFor: (modelSlug: string | null) => VisionPreprocessor | null;
  correlationId: string;
}): { describe: ToolImageDescriber; model: string | null } | null {
  if (!input.settings['ai.visionEnabled']) return null;
  let slug: string | null;
  // The describer speaks to OpenRouter. A subscription preset's slug
  // (`cline-pass/...`) is a name only the preset knows, and OpenRouter answers
  // it with a 400, so such a model borrows the companion like a text-only one.
  if (input.modelRow.supportsVision && !isProviderPresetId(input.modelRow.provider)) {
    slug = input.modelRow.slug;
  } else {
    const companion = resolveVisionCompanionSlug(
      input.conversationCompanionSlug,
      input.modelRow.visionCompanionSlug,
    );
    if (companion === 'off') return null;
    slug = companion;
  }
  const preprocessor = input.visionPreprocessorFor(slug);
  if (preprocessor === null) return null;
  return {
    model: slug,
    describe: async (image, label) =>
      preprocessor.describeImage({
        data: Buffer.from(image.data, 'base64'),
        mimeType: image.mimeType,
        label,
        correlationId: input.correlationId,
        timeoutMs: 30_000,
      }),
  };
}

/**
 * The words the tool selection is made from (issue #121).
 *
 * The user's own messages and nothing else: an assistant turn is this system
 * talking to itself, and a tool result is a page, which would switch domains
 * on because of what somebody once wrote rather than what was asked for now.
 * The last few, because a conversation that moved from a database to a page
 * should stop being about databases eventually -- but not immediately, or a
 * follow-up of three words ("und jetzt sortieren") would lose the domain the
 * question before it established.
 */
export function taskTextFor(messages: readonly AiMessage[]): string {
  const RECENT_USER_MESSAGES = 3;
  return messages
    .filter((message) => message.role === 'user')
    .slice(-RECENT_USER_MESSAGES)
    .map((message) => message.content)
    .join('\n');
}
