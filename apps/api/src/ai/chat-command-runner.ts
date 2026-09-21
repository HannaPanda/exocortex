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

export interface ChatCommandContext {
  prisma: PrismaClient;
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
  return answer(context, 'clear', 'Kontext geleert. Der Verlauf bleibt lesbar.');
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
    message: `Neue Unterhaltung „${title}“ gestartet.`,
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
    `Modell gewechselt zu ${await displayNameOf(prisma, resolved.id)}.`,
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
      ? `Denkstufe auf ${clamped} gesetzt.`
      : `${await displayNameOf(prisma, modelRow.id)} unterstützt diese Stufe nicht, verwende stattdessen ${clamped}.`;
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
    return answer(context, 'vision', 'Vision-Begleitmodell folgt jetzt der Admin-Voreinstellung.');
  }
  if (argument === 'off') {
    await update('off');
    return answer(context, 'vision', 'Vision-Begleitmodell für diese Unterhaltung deaktiviert.');
  }
  const resolved = await modelResolver.resolve({ slug: argument });
  await update(resolved.slug);
  return answer(
    context,
    'vision',
    `Vision-Begleitmodell auf ${await displayNameOf(prisma, resolved.id)} gesetzt.`,
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
  Promise.resolve(
    answer(
      context,
      'compact',
      'Der Kontext wird automatisch zusammengefasst, sobald er das Limit erreicht. Nutze /clear, um ihn sofort zu leeren.',
    ),
  );

/** Reports, and optionally switches, whether the open page reaches the prompt. */
const pageContext: ChatCommandHandler = async (context) => {
  const { prisma, conversation, command } = context;
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

  const where =
    page === null ? 'Es ist gerade keine Seite geöffnet.' : `Geöffnet ist „${page.title}“.`;
  const what = enabled
    ? page === null
      ? 'Sobald du eine Seite öffnest, erfährt die KI Titel und Pfad und kann den Inhalt bei Bedarf selbst laden.'
      : 'Die KI erfährt Titel und Pfad und kann den Inhalt bei Bedarf selbst laden.'
    : 'Der Seitenkontext ist aus: die KI erfährt nichts davon.';
  const how = enabled
    ? 'Mit /context off schaltest du ihn ab.'
    : 'Mit /context on schaltest du ihn an.';

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
      ? 'Angeheftet ist nichts.'
      : `Angeheftet ${pinned.length === 1 ? 'ist' : 'sind'} außerdem: ${pinned
          .map((source) => {
            const title = source.document?.title ?? source.savedQuery?.name ?? 'Unbenannt';
            return `„${title}“ (${source.mode === 'EMBED' ? 'Inhalt geht mit' : 'nur genannt'})`;
          })
          .join(', ')}.`;

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
      ? 'Keine aktiven KI-Regelseiten in diesem Arbeitsbereich.'
      : rules
          .map((rule) => {
            const kind = rule.aiRuleMode === 'ALWAYS' ? 'immer aktiv' : 'auf Anfrage';
            const trigger = rule.aiRuleTrigger !== null ? `: ${rule.aiRuleTrigger}` : '';
            return `- ${rule.title} (${kind})${trigger}`;
          })
          .join('\n');
  return answer(context, 'rules', message);
};

/** How the workspace's `ai.untrustedContentPolicy` reads to a human. */
const MUTATION_POLICY_LINE: Record<AiMutationPolicy, string> = {
  deny: 'Verändernde Werkzeuge sind in diesem Arbeitsbereich abgeschaltet.',
  guarded:
    'Verändernde Werkzeuge sind gesperrt, sobald ein Lauf Inhalte von außerhalb gelesen hat ' +
    '(hochgeladene Dokumente, Bildbeschreibungen).',
  allow: 'Verändernde Werkzeuge bleiben auch nach dem Lesen von Fremdinhalten erlaubt.',
};

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
      ? 'Keine Werkzeuge verfügbar.'
      : [
          ...tools.map((tool) => `- ${tool.name} — ${tool.description}`),
          '',
          MUTATION_POLICY_LINE[policy],
          // The whole list is what the AI *may* call; a single run is offered
          // the domains its task needs, and opens the rest itself with
          // exo_toolbox (issue #121, ADR-060).
          'Ein einzelner Lauf bekommt nicht alle davon angeboten, sondern die Bereiche, die zur ' +
            'Frage passen. Fehlt einer, schaltet die KI ihn sich mit exo_toolbox selbst frei.',
        ].join('\n');
  return answer(context, 'tools', message);
};

const help: ChatCommandHandler = (context) =>
  Promise.resolve(
    answer(
      context,
      'help',
      CHAT_COMMANDS.map(
        (entry) =>
          `/${entry.name}${entry.argument !== null ? ` <${entry.argument}>` : ''} — ${entry.description}`,
      ).join('\n'),
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
