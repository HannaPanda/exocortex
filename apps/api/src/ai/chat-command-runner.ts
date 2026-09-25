import {
  type AiMutationPolicy,
  aiReasoningLevelSchema,
  CHAT_COMMANDS,
  type ChatCommandName,
  type ChatCommandResult,
} from '@exocortex/contracts';
import {
  type AiReasoningLevel as AiReasoningLevelPrisma,
  type PrismaClient,
} from '@exocortex/database';
import { type serverTranslator } from '@exocortex/i18n/catalog';
import { toolsFor } from '@exocortex/mcp-tools';

import { AppError } from '../common/app-error';
import { type SettingsService } from '../platform/settings.service';

import {
  type AiModelResolverService,
  REASONING_LEVEL_TO_PRISMA,
} from './ai-model-resolver.service';
import { type ParsedChatCommand } from './chat-commands';

const PLACEHOLDER_TITLE = 'Neue Unterhaltung';

/** The part of a conversation row a command may look at. */
export interface ChatCommandConversation {
  id: string;
  workspaceId: string;
  createdById: string;
  documentId: string | null;
  pageContextEnabled: boolean;
  modelId: string | null;
  reasoningLevel: AiReasoningLevelPrisma;
  model: { slug: string } | null;
}

/**
 * The `commands` namespace in the locale of whoever typed the command
 * (issue #98, ADR-062). The answer is read by that person and nobody else.
 */
export type ChatCommandTranslator = ReturnType<typeof serverTranslator<'commands'>>;

export interface ChatCommandContext {
  prisma: PrismaClient;
  t: ChatCommandTranslator;
  modelResolver: AiModelResolverService;
  settings: SettingsService;
  conversation: ChatCommandConversation;
  command: ParsedChatCommand;
}

type ChatCommandHandler = (context: ChatCommandContext) => Promise<ChatCommandResult>;

/** Every command answers about the conversation it ran in, unless it started a new one. */
function answer(
  context: ChatCommandContext,
  command: ChatCommandName,
  message: string,
): ChatCommandResult {
  return {
    command,
    message,
    conversationId: context.conversation.id,
    conversationChanged: false,
  };
}

async function displayNameOf(prisma: PrismaClient, modelId: string): Promise<string> {
  const row = await prisma.aiModel.findUnique({
    where: { id: modelId },
    select: { displayName: true },
  });
  return row?.displayName ?? modelId;
}

/** Supersedes the transcript so the next run starts from an empty context. */
const clear: ChatCommandHandler = async (context) => {
  const { prisma, conversation } = context;
  await prisma.aiConversationMessage.updateMany({
    where: { conversationId: conversation.id, supersededAt: null },
    data: { supersededAt: new Date() },
  });
  await prisma.aiConversation.update({
    where: { id: conversation.id },
    data: { estimatedTokens: 0 },
  });
  return answer(context, 'clear', context.t('clear.done'));
};

/** Starts a second conversation beside this one, with the same model settings. */
const startNew: ChatCommandHandler = async (context) => {
  const { prisma, conversation, command } = context;
  const title = command.argument ?? PLACEHOLDER_TITLE;
  const created = await prisma.aiConversation.create({
    data: {
      workspaceId: conversation.workspaceId,
      createdById: conversation.createdById,
      title,
      modelId: conversation.modelId,
      reasoningLevel: conversation.reasoningLevel,
    },
  });
  return {
    command: 'new',
    message: context.t('new.started', { title }),
    conversationId: created.id,
    conversationChanged: true,
  };
};

const switchModel: ChatCommandHandler = async (context) => {
  const { prisma, conversation, command, modelResolver } = context;
  if (command.argument === null) {
    throw AppError.validation('The /model command requires a model slug argument');
  }
  const resolved = await modelResolver.resolve({ slug: command.argument });
  await prisma.aiConversation.update({
    where: { id: conversation.id },
    data: { modelId: resolved.id },
  });
  return answer(
    context,
    'model',
    context.t('model.switched', { model: await displayNameOf(prisma, resolved.id) }),
  );
};

/** Sets the reasoning level, clamped to what the conversation's model supports. */
const setReasoning: ChatCommandHandler = async (context) => {
  const { prisma, conversation, command, modelResolver } = context;
  if (command.argument === null) {
    throw AppError.validation('The /think command requires a reasoning level argument');
  }
  const parsedLevel = aiReasoningLevelSchema.safeParse(command.argument);
  if (!parsedLevel.success) {
    throw AppError.validation(`Unknown reasoning level "${command.argument}"`);
  }
  const modelRow =
    conversation.model === null
      ? await modelResolver.resolveDefault(conversation.workspaceId)
      : await modelResolver.resolve({ slug: conversation.model.slug, allowDisabled: true });
  const clamped = modelResolver.clampReasoningLevel(modelRow, parsedLevel.data);
  await prisma.aiConversation.update({
    where: { id: conversation.id },
    data: { reasoningLevel: REASONING_LEVEL_TO_PRISMA[clamped] },
  });
  const message =
    clamped === parsedLevel.data
      ? context.t('think.set', { level: clamped })
      : context.t('think.clamped', {
          model: await displayNameOf(prisma, modelRow.id),
          level: clamped,
        });
  return answer(context, 'think', message);
};

/** Chooses the vision companion for this conversation: `auto`, `off`, or a slug. */
const setVision: ChatCommandHandler = async (context) => {
  const { prisma, conversation, command, modelResolver } = context;
  const argument = command.argument?.toLowerCase() ?? 'auto';
  const update = async (visionCompanionSlug: string | null): Promise<void> => {
    await prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { visionCompanionSlug },
    });
  };

  if (argument === 'auto') {
    await update(null);
    return answer(context, 'vision', context.t('vision.auto'));
  }
  if (argument === 'off') {
    await update('off');
    return answer(context, 'vision', context.t('vision.off'));
  }
  const resolved = await modelResolver.resolve({ slug: argument });
  await update(resolved.slug);
  return answer(
    context,
    'vision',
    context.t('vision.set', { model: await displayNameOf(prisma, resolved.id) }),
  );
};

/**
 * Compacting synchronously here would call the provider from inside the API
 * process, which rule 6 forbids. Compaction already runs automatically in the
 * worker before every provider call once the context passes its threshold (see
 * compaction.ts); `/clear` is the only way to force it immediately
 * (docs/ai-architecture.md).
 */
const compact: ChatCommandHandler = (context) =>
  Promise.resolve(answer(context, 'compact', context.t('compact.automatic')));

/** Reports, and optionally switches, whether the open page reaches the prompt. */
const pageContext: ChatCommandHandler = async (context) => {
  const { prisma, conversation, command, t } = context;
  const argument = command.argument?.toLowerCase() ?? null;
  if (argument !== null && argument !== 'on' && argument !== 'off') {
    throw AppError.validation('The /context command accepts "on" or "off"');
  }
  if (argument !== null) {
    await prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { pageContextEnabled: argument === 'on' },
    });
  }
  const enabled = argument === null ? conversation.pageContextEnabled : argument === 'on';

  // Reported from `documentId`, which keeps tracking the page even while
  // the context is off -- that is what makes `/context on` meaningful
  // without having to navigate somewhere first.
  const page =
    conversation.documentId === null
      ? null
      : await prisma.document.findFirst({
          where: { id: conversation.documentId, workspaceId: conversation.workspaceId },
          select: { title: true },
        });

  const where = page === null ? t('context.noPage') : t('context.openPage', { title: page.title });
  const what = enabled
    ? page === null
      ? t('context.enabledNoPage')
      : t('context.enabled')
    : t('context.disabled');
  const how = enabled ? t('context.howOff') : t('context.howOn');

  // The pinned sources belong in the same answer, because the promise the chip
  // row makes is about all of them together: naming only the open page here
  // would describe half of what leaves (issue #75).
  const pinned = await prisma.aiConversationSource.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'asc' },
    select: {
      mode: true,
      document: { select: { title: true } },
      savedQuery: { select: { name: true } },
    },
  });
  const sources =
    pinned.length === 0
      ? t('context.nothingPinned')
      : t('context.pinned', {
          count: pinned.length,
          list: pinned
            .map((source) => {
              const title =
                source.document?.title ?? source.savedQuery?.name ?? t('context.untitled');
              return source.mode === 'EMBED'
                ? t('context.sourceEmbedded', { title })
                : t('context.sourceNamed', { title });
            })
            .join(', '),
        });

  return answer(context, 'context', [where, what, how, sources].join(' '));
};

/** Lists the workspace's active AI rule pages. */
const listRules: ChatCommandHandler = async (context) => {
  const rules = await context.prisma.document.findMany({
    where: {
      workspaceId: context.conversation.workspaceId,
      archivedAt: null,
      aiRuleMode: { not: 'OFF' },
    },
    orderBy: [{ aiRulePriority: 'asc' }, { title: 'asc' }],
    select: { title: true, aiRuleMode: true, aiRuleTrigger: true },
  });
  const message =
    rules.length === 0
      ? context.t('rules.none')
      : rules
          .map((rule) => {
            const kind =
              rule.aiRuleMode === 'ALWAYS'
                ? context.t('rules.always')
                : context.t('rules.onRequest');
            const trigger = rule.aiRuleTrigger !== null ? `: ${rule.aiRuleTrigger}` : '';
            return `- ${rule.title} (${kind})${trigger}`;
          })
          .join('\n');
  return answer(context, 'rules', message);
};

/** How the workspace's `ai.untrustedContentPolicy` reads to a human: a key in `commands.tools`. */
const MUTATION_POLICY_LINE = {
  deny: 'tools.policyDeny',
  guarded: 'tools.policyGuarded',
  allow: 'tools.policyAllow',
} as const satisfies Record<AiMutationPolicy, string>;

/** Lists the tools the AI may call right now, and under which conditions. */
const listTools: ChatCommandHandler = async (context) => {
  const settings = await context.settings.getForWorkspace(context.conversation.workspaceId);
  const policy = settings['ai.untrustedContentPolicy'];
  const includeMutating = settings['ai.mutatingToolsEnabled'] && policy !== 'deny';
  const tools = toolsFor('ai', { includeMutating });
  // The list alone answers "what can it do" but not "why did it refuse", which
  // is the question somebody asks right after a refused write (issue #56).
  const message =
    tools.length === 0
      ? context.t('tools.none')
      : [
          // The description is the model-facing text of the catalogue, and
          // stays as the catalogue writes it (docs/i18n.md).
          ...tools.map((tool) => `- ${tool.name} — ${tool.description}`),
          '',
          context.t(MUTATION_POLICY_LINE[policy]),
          // The whole list is what the AI *may* call; a single run is offered
          // the domains its task needs, and opens the rest itself with
          // exo_toolbox (issue #121, ADR-060).
          context.t('tools.subset'),
        ].join('\n');
  return answer(context, 'tools', message);
};

const help: ChatCommandHandler = (context) =>
  Promise.resolve(
    answer(
      context,
      'help',
      CHAT_COMMANDS.map((entry) => {
        // `/new`'s argument is a placeholder the reader fills in; the others
        // are syntax the parser reads, the same in every language.
        const argument =
          entry.argument === null
            ? ''
            : ` <${entry.name === 'new' ? context.t('help.titleArgument') : entry.argument}>`;
        return `/${entry.name}${argument} — ${context.t(`help.descriptions.${entry.name}`)}`;
      }).join('\n'),
    ),
  );

/**
 * Every slash command, by name.
 *
 * A `Record` over the command union rather than a switch: a command added to
 * the contract without a handler is a type error, which is what the old
 * `default` branch could only report at runtime.
 */
const HANDLERS: Record<ChatCommandName, ChatCommandHandler> = {
  clear,
  new: startNew,
  model: switchModel,
  think: setReasoning,
  vision: setVision,
  compact,
  context: pageContext,
  rules: listRules,
  tools: listTools,
  help,
};

/** Runs one parsed slash command against its conversation. */
export async function runChatCommand(context: ChatCommandContext): Promise<ChatCommandResult> {
  const handler = HANDLERS[context.command.name];
  // Unreachable: `parseChatCommand` only ever returns a name from
  // `CHAT_COMMANDS`, and the record above is total over that union.
  if (handler === undefined) {
    throw AppError.internal(`Unhandled chat command "${context.command.name}"`);
  }
  return handler(context);
}
