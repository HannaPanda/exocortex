import { describe, expect, it } from 'vitest';

import {
  activeConversationKey,
  chooseActiveConversation,
  type ConversationStorage,
  pageConversationKey,
  recordShownConversation,
  resolveActiveConversation,
} from './panel-state';

/** One browser: a shared `localStorage` and a `sessionStorage` per tab. */
function browser() {
  const local = new Map<string, string>();
  const tab = (
    session = new Map<string, string>(),
  ): ConversationStorage & {
    session: Map<string, string>;
    clone: () => ConversationStorage & { session: Map<string, string> };
  } => ({
    session,
    readTab: (key) => session.get(key) ?? null,
    writeTab: (key, raw) => void session.set(key, raw),
    readSeed: (key) => local.get(key) ?? null,
    writeSeed: (key, raw) => void local.set(key, raw),
    // Duplicating a tab copies its sessionStorage, and nothing after that.
    clone: () => tab(new Map(session)),
  });
  return { local, tab };
}

/** What the panel does: resolve, show, and record what it showed. */
function show(storage: ConversationStorage, documentId: string | null): string | null {
  const shown = resolveActiveConversation(storage, 'ws', documentId);
  recordShownConversation(storage, 'ws', documentId, shown);
  return shown;
}

describe('the active conversation (issue #231)', () => {
  it('keeps a choice in one tab out of another tab', () => {
    const { tab } = browser();
    const first = tab();
    const second = tab();
    chooseActiveConversation(first, 'ws', 'page-a', 'chat-x');
    expect(show(second, 'page-b')).toBe('chat-x'); // a new tab starts from the latest choice
    chooseActiveConversation(first, 'ws', 'page-a', 'chat-y');
    expect(show(second, 'page-b')).toBe('chat-x');
    expect(show(first, 'page-a')).toBe('chat-y');
  });

  it('lets a cloned tab start where its original was and then go its own way', () => {
    const { tab } = browser();
    const original = tab();
    chooseActiveConversation(original, 'ws', 'page-a', 'chat-x');
    const clone = original.clone();
    expect(show(clone, 'page-a')).toBe('chat-x');
    chooseActiveConversation(clone, 'ws', 'page-a', 'chat-y');
    expect(show(original, 'page-a')).toBe('chat-x');
    expect(show(clone, 'page-a')).toBe('chat-y');
  });

  it('carries the chat on to a page without one and brings each page its own back', () => {
    const { tab } = browser();
    const one = tab();
    chooseActiveConversation(one, 'ws', 'page-a', 'chat-x');
    expect(show(one, 'page-b')).toBe('chat-x');
    chooseActiveConversation(one, 'ws', 'page-b', 'chat-y');
    expect(show(one, 'page-a')).toBe('chat-x');
    // The tab carries what it showed last, so a fresh page continues chat-x.
    expect(show(one, 'page-c')).toBe('chat-x');
    expect(show(one, 'page-b')).toBe('chat-y');
  });

  it('remembers an emptied panel on its page instead of looking past it', () => {
    const { tab } = browser();
    const one = tab();
    chooseActiveConversation(one, 'ws', 'page-a', 'chat-x');
    chooseActiveConversation(one, 'ws', 'page-b', null);
    expect(show(one, 'page-a')).toBe('chat-x');
    expect(show(one, 'page-b')).toBeNull();
  });

  it('survives a reload, which keeps sessionStorage', () => {
    const { tab } = browser();
    const one = tab();
    chooseActiveConversation(one, 'ws', 'page-a', 'chat-x');
    const reloaded = tab(one.session);
    expect(show(reloaded, 'page-a')).toBe('chat-x');
  });

  it('starts a brand-new browser from the key the panel used before', () => {
    const { local, tab } = browser();
    local.set(activeConversationKey('ws'), JSON.stringify('chat-old'));
    const one = tab();
    expect(show(one, 'page-a')).toBe('chat-old');
    expect(one.session.get(pageConversationKey('ws', 'page-a'))).toBe(JSON.stringify('chat-old'));
  });

  it('reads a corrupt entry as no conversation', () => {
    const { tab } = browser();
    const one = tab();
    one.session.set(pageConversationKey('ws', 'page-a'), '{not json');
    expect(resolveActiveConversation(one, 'ws', 'page-a')).toBeNull();
  });
});
