import { type AiConversationMessage, type AiConversationRole } from '@exocortex/contracts';

/**
 * A transcript as Markdown, for saving a chat as a page (issue #69, AP5).
 *
 * Pure and free of Prisma on purpose: this is the part of "save as page" that
 * can be wrong in a way nothing notices -- a role rendered as a heading that
 * swallows the next one, a fenced tool result that closes early -- and a unit
 * test is the cheapest place to find that out.
 *
 * Two decisions worth stating. Retired messages (`superseded`) are kept: they
 * are part of what was said, and a saved page that silently drops the half a
 * compaction replaced would be a different conversation than the one on
 * screen. And nothing here is a Markdown heading below `##`, so the page's own
 * outline stays readable: one turn is a bold role line, not a section.
 */

const ROLE_LABELS: Record<AiConversationRole, string> = {
  user: 'Du',
  assistant: 'KI',
  system: 'System',
  tool: 'Werkzeug',
};

/** Longest run of backticks in a string, so a fence can always be longer. */
function longestBacktickRun(text: string): number {
  let longest = 0;
  let current = 0;
  for (const character of text) {
    if (character === '`') {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/** Fences `text` so its own backticks cannot close the block early. */
function fence(text: string, info: string): string {
  const marker = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${marker}${info}\n${text}\n${marker}`;
}

function renderMessage(message: AiConversationMessage): string {
  const label = ROLE_LABELS[message.role];
  const notes: string[] = [];
  if (message.isSummary) notes.push('Zusammenfassung');
  if (message.superseded) notes.push('nicht mehr im Kontext');
  const suffix = notes.length === 0 ? '' : ` _(${notes.join(', ')})_`;

  if (message.role === 'tool') {
    const name = message.toolName ?? 'unbekannt';
    return `**${label} · ${name}**${suffix}\n\n${fence(message.content, '')}`;
  }
  return `**${label}**${suffix}\n\n${message.content}`;
}

export interface TranscriptMarkdownInput {
  title: string;
  workspaceName: string | null;
  documentTitle: string | null;
  modelSlug: string | null;
  createdAt: string;
  lastMessageAt: string;
  messages: readonly AiConversationMessage[];
}

/**
 * The saved page's body: a short provenance block, then the turns.
 *
 * The provenance block is not decoration. A transcript pasted into a workspace
 * without it reads as somebody's considered prose a week later, and the whole
 * point of saving a chat is that it was a conversation with a model.
 */
export function conversationToMarkdown(input: TranscriptMarkdownInput): string {
  const facts = [
    `Unterhaltung vom ${input.createdAt}, zuletzt ${input.lastMessageAt}`,
    input.workspaceName === null ? null : `Arbeitsbereich: ${input.workspaceName}`,
    input.documentTitle === null ? null : `Seite: ${input.documentTitle}`,
    input.modelSlug === null ? null : `Modell: ${input.modelSlug}`,
  ].filter((fact): fact is string => fact !== null);

  const header = [
    '> Gesicherter Verlauf einer KI-Unterhaltung.',
    ...facts.map((fact) => `> ${fact}`),
  ].join('\n');

  const body = input.messages.map((message) => renderMessage(message)).join('\n\n');
  return body.length === 0
    ? `${header}\n\n_Diese Unterhaltung hat keine Nachrichten._`
    : `${header}\n\n${body}`;
}
