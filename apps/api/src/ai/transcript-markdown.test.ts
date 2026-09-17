import { describe, expect, it } from 'vitest';

import { type AiConversationMessage } from '@exocortex/contracts';

import { decodeCursor, encodeCursor } from './conversation-archive.service';
import { conversationToMarkdown } from './transcript-markdown';

function message(input: Partial<AiConversationMessage>): AiConversationMessage {
  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    role: 'user',
    content: 'Hallo',
    toolName: null,
    toolCallId: null,
    isSummary: false,
    superseded: false,
    runId: null,
    createdAt: '2026-09-17T09:00:00.000Z',
    ...input,
  };
}

const base = {
  title: 'nginx umstellen',
  workspaceName: 'Second Brain',
  documentTitle: 'Technik',
  modelSlug: 'anthropic/claude-sonnet-4.5',
  createdAt: '2026-09-17T08:00:00.000Z',
  lastMessageAt: '2026-09-17T09:00:00.000Z',
};

describe('conversationToMarkdown', () => {
  it('states where the text came from before the first turn', () => {
    const markdown = conversationToMarkdown({ ...base, messages: [message({})] });
    expect(markdown.startsWith('> Gesicherter Verlauf einer KI-Unterhaltung.')).toBe(true);
    expect(markdown).toContain('> Arbeitsbereich: Second Brain');
    expect(markdown).toContain('> Seite: Technik');
    expect(markdown).toContain('**Du**\n\nHallo');
  });

  it('leaves out the facts it does not have instead of writing empty ones', () => {
    const markdown = conversationToMarkdown({
      ...base,
      workspaceName: null,
      documentTitle: null,
      modelSlug: null,
      messages: [],
    });
    expect(markdown).not.toContain('Arbeitsbereich:');
    expect(markdown).not.toContain('Seite:');
    expect(markdown).toContain('keine Nachrichten');
  });

  it('marks a retired message rather than dropping it', () => {
    const markdown = conversationToMarkdown({
      ...base,
      messages: [message({ superseded: true, isSummary: true, role: 'assistant' })],
    });
    expect(markdown).toContain('**KI** _(Zusammenfassung, nicht mehr im Kontext)_');
  });

  it('fences a tool result longer than its own backticks', () => {
    const markdown = conversationToMarkdown({
      ...base,
      messages: [message({ role: 'tool', toolName: 'exo_page_read', content: '```js\nx\n```' })],
    });
    expect(markdown).toContain('**Werkzeug · exo_page_read**');
    // The fence has to outrun the three backticks inside the payload.
    expect(markdown).toContain('````\n```js\nx\n```\n````');
  });
});

describe('the list cursor', () => {
  it('survives a round trip', () => {
    const row = { lastMessageAt: new Date('2026-09-17T09:00:00.000Z'), id: 'conv-42' };
    const decoded = decodeCursor(encodeCursor(row));
    expect(decoded.id).toBe('conv-42');
    expect(decoded.lastMessageAt.toISOString()).toBe('2026-09-17T09:00:00.000Z');
  });

  it('refuses something that was not issued here', () => {
    expect(() => decodeCursor('bm90LWEtY3Vyc29y')).toThrow(/cursor/i);
  });
});
