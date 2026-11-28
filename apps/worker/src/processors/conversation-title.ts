import { type AiProvider } from '@exocortex/ai';
import {
  AI_CONVERSATION_SUGGESTED_TITLE_MAX_CHARS,
  type AiConversationTitleSuggestion,
  type QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type JobHandler } from '@exocortex/queue';

import { type ResolvedAiKey, WorkspaceKeyUnreadableError } from '../ai-key';

/**
 * Suggests a title for a conversation because its owner asked (issue #233).
 *
 * What the model reads is the conversation's own words and nothing else: the
 * person's messages and the assistant's answers. Tool results, summaries,
 * context markers and the text of attached files stay out, so a document
 * somebody else wrote cannot name the chat (ADR-030), and the prompt stays a
 * few thousand characters however long the conversation is.
 *
 * Nothing is written. The suggestion goes back to the request that is waiting
 * for it, the rename dialog shows it in its field, and only the person's save
 * stores it, so a title somebody chose is never replaced behind their back.
 * Every failure is an answer rather than a throw: one attempt, and a waiting
 * request that should hear why.
 */

export interface ConversationTitleDependencies {
  prisma: PrismaClient;
  settings: (workspaceId?: string) => Promise<Settings>;
  /** The same resolution an AI run uses, so the same key pays (ADR-090, ADR-091). */
  providerFor: (
    workspaceId: string,
    providerId?: string,
  ) => Promise<{ provider: AiProvider; key: ResolvedAiKey; openRouter?: AiProvider }>;
}

const TITLE_PROMPT =
  'Du bekommst Auszüge aus einer Unterhaltung zwischen einer Person und einem KI-Assistenten. ' +
  'Schlage einen kurzen, treffenden Titel dafür vor: höchstens sechs Wörter, ohne ' +
  'Anführungszeichen, ohne Punkt am Ende, ohne Einleitung. Benenne das Thema, nicht die ' +
  'Gesprächsform. Schreib in der Sprache, in der die Person schreibt. Antworte nur mit dem Titel.';

/** Characters of transcript the model reads at most. */
export const TITLE_TRANSCRIPT_MAX_CHARS = 6_000;
/** Characters of one message the model reads at most. */
export const TITLE_MESSAGE_MAX_CHARS = 800;
const GAP_MARKER = '[…]';

export interface TitleSourceMessage {
  role: 'USER' | 'ASSISTANT';
  content: string;
}

/**
 * The excerpt a title is written from: the first message always, because it
 * usually says what the conversation set out to do, then as many of the most
 * recent ones as fit, because a conversation drifts and its title should be
 * about where it went. Each message is cut on its own, so one long answer
 * cannot take the whole budget.
 */
export function titleTranscript(messages: readonly TitleSourceMessage[]): string {
  const lines = messages
    .map((message) => {
      const collapsed = message.content.replace(/\s+/g, ' ').trim();
      const text =
        collapsed.length > TITLE_MESSAGE_MAX_CHARS
          ? `${collapsed.slice(0, TITLE_MESSAGE_MAX_CHARS - 1)}…`
          : collapsed;
      return { text, line: `${message.role === 'USER' ? 'Person' : 'Assistent'}: ${text}` };
    })
    .filter((entry) => entry.text.length > 0)
    .map((entry) => entry.line);
  if (lines.length === 0) return '';

  const [first, ...rest] = lines as [string, ...string[]];
  let used = first.length;
  const tail: string[] = [];
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const line = rest[index] as string;
    if (used + line.length + 2 > TITLE_TRANSCRIPT_MAX_CHARS) break;
    tail.unshift(line);
    used += line.length + 2;
  }
  const skipped = rest.length - tail.length;
  return [first, ...(skipped > 0 ? [GAP_MARKER] : []), ...tail].join('\n\n');
}

/**
 * Turns what the model said into a title, or `null` when nothing usable is
 * left: the first line that says anything, without a "Titel:" lead-in,
 * Markdown, quotes or a final full stop, cut at a word where it is too long.
 */
export function cleanSuggestedTitle(raw: string): string | null {
  const line = raw
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (line === undefined) return null;

  let title = line
    .replace(/^(?:#+\s*|[-*]\s+)/, '')
    .replace(/^(?:vorgeschlagener\s+)?(?:titel|title)\s*:\s*/i, '')
    .replace(/[*_`]/g, '')
    .replace(/^["'„“”«»‚‘’]+|["'„“”«»‚‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '')
    .trim();

  if (title.length > AI_CONVERSATION_SUGGESTED_TITLE_MAX_CHARS) {
    const cut = title.slice(0, AI_CONVERSATION_SUGGESTED_TITLE_MAX_CHARS);
    const lastSpace = cut.lastIndexOf(' ');
    title = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
  }
  return title.length === 0 ? null : title;
}

export function createConversationTitleProcessor(
  dependencies: ConversationTitleDependencies,
): JobHandler<typeof QUEUE_NAMES.conversationTitle> {
  const { prisma } = dependencies;

  return async ({ payload, logger }): Promise<AiConversationTitleSuggestion> => {
    const messages = await prisma.aiConversationMessage.findMany({
      where: {
        conversationId: payload.conversationId,
        role: { in: ['USER', 'ASSISTANT'] },
        isSummary: false,
      },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true },
    });
    const transcript = titleTranscript(
      messages.flatMap((message) =>
        message.role === 'USER' || message.role === 'ASSISTANT'
          ? [{ role: message.role, content: message.content }]
          : [],
      ),
    );
    if (transcript.length === 0) return { outcome: 'failed', reason: 'nothing_to_name' };

    let resolved: Awaited<ReturnType<ConversationTitleDependencies['providerFor']>>;
    try {
      resolved = await dependencies.providerFor(payload.workspaceId, payload.provider);
    } catch (error) {
      if (error instanceof WorkspaceKeyUnreadableError) {
        logger.warn('Title suggestion refused: the workspace key cannot be read', {
          conversationId: payload.conversationId,
          reason: error.reason,
        });
        return { outcome: 'failed', reason: 'key_unreadable' };
      }
      throw error;
    }

    // The choice a compaction makes: naming a conversation is summarising it
    // in a few words, so the model configured for summaries writes it, and a
    // configured slug is an OpenRouter one.
    const settings = await dependencies.settings(payload.workspaceId);
    const summaryModel = settings['ai.compactionModelSlug'];
    const provider =
      summaryModel === null ? resolved.provider : (resolved.openRouter ?? resolved.provider);

    let raw: string;
    try {
      const result = await provider.generate({
        messages: [
          { role: 'system', content: TITLE_PROMPT },
          { role: 'user', content: transcript },
        ],
        model: summaryModel ?? payload.model,
        // A handful of words, with room for a model that thinks first.
        maxOutputTokens: 400,
        temperature: 0.3,
        correlationId: payload.correlationId,
        timeoutMs: 20_000,
      });
      raw = result.text;
    } catch (error) {
      logger.warn('Title suggestion failed at the model', {
        conversationId: payload.conversationId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return { outcome: 'failed', reason: 'provider_failed' };
    }

    const title = cleanSuggestedTitle(raw);
    if (title === null) {
      logger.warn('Title suggestion came back empty', { conversationId: payload.conversationId });
      return { outcome: 'failed', reason: 'provider_failed' };
    }
    logger.info('Title suggested for conversation', {
      conversationId: payload.conversationId,
      usedOwnKey: resolved.key.usedOwnKey,
    });
    return { outcome: 'suggested', title };
  };
}
