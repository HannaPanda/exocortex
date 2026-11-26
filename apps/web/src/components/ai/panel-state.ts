/**
 * Which conversation the chat panel shows, decided per browser tab and per
 * page (issue #231).
 *
 * The panel used to keep one active conversation per workspace in
 * `localStorage` and listened for the `storage` event, so choosing a chat in
 * one tab switched every other tab to it. Now the answer lives in the tab's
 * own `sessionStorage`, which a browser copies when a tab is duplicated and
 * never shares afterwards: a cloned tab starts where its original was, and
 * from then on each goes its own way. A reload keeps it, because
 * `sessionStorage` survives one.
 *
 * Inside a tab there are two layers:
 *
 * - the page's own entry: the conversation that was last shown on this page
 *   in this tab, so coming back to a page brings its chat back with it;
 * - the tab's entry: the conversation last shown anywhere in this tab, which
 *   a page without an entry of its own takes over. That keeps what the panel
 *   always did: walk to another page and keep typing into the same transcript.
 *
 * A tab that has neither (a new tab, or a link opened in one) starts from the
 * conversation most recently chosen in any tab, read once from
 * `localStorage` and then copied into the tab, so a later choice in another
 * tab no longer reaches it. That is also the key the panel used before, so
 * nobody loses the chat they had open.
 *
 * Everything here is pure over a small storage interface, so the rules can be
 * tested without a browser; `use-active-conversation.ts` binds it to the real
 * storage areas and to React.
 */

/** The two places a conversation id is kept, each as JSON (a string or null). */
export interface ConversationStorage {
  /** This tab only: `sessionStorage`. */
  readTab: (key: string) => string | null;
  writeTab: (key: string, raw: string) => void;
  /** Every tab, read once by a tab that has nothing yet: `localStorage`. */
  readSeed: (key: string) => string | null;
  writeSeed: (key: string, raw: string) => void;
}

/** The tab's entry for a workspace, and the seed's key in `localStorage`. */
export function activeConversationKey(workspaceId: string | null): string {
  return `exocortex.ai.conversation.${workspaceId ?? 'none'}`;
}

/** The entry one page has in this tab. */
export function pageConversationKey(workspaceId: string, documentId: string): string {
  return `${activeConversationKey(workspaceId)}.page.${documentId}`;
}

export function parseConversationId(raw: string): string | null {
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'string' ? parsed : null;
}

/** A corrupt entry reads as "no conversation" rather than breaking the panel. */
function parseStored(raw: string): string | null {
  try {
    return parseConversationId(raw);
  } catch {
    return null;
  }
}

/**
 * The conversation to show on a page in this tab.
 *
 * Reads only. `undefined` from a layer means it has no entry; a stored `null`
 * is an answer ("this page had an empty panel") and is not looked past.
 */
export function resolveActiveConversation(
  storage: ConversationStorage,
  workspaceId: string,
  documentId: string | null,
): string | null {
  if (documentId !== null) {
    const page = storage.readTab(pageConversationKey(workspaceId, documentId));
    if (page !== null) return parseStored(page);
  }
  const key = activeConversationKey(workspaceId);
  const tab = storage.readTab(key) ?? storage.readSeed(key);
  return tab === null ? null : parseStored(tab);
}

/**
 * Records what the panel is showing, after it showed it.
 *
 * The page keeps it as its own, and the tab carries it on to the next page
 * that has none. A tab that started from the seed copies it in here, which is
 * the moment it stops following other tabs.
 */
export function recordShownConversation(
  storage: ConversationStorage,
  workspaceId: string,
  documentId: string | null,
  conversationId: string | null,
): void {
  const raw = JSON.stringify(conversationId);
  if (documentId !== null) {
    const pageKey = pageConversationKey(workspaceId, documentId);
    if (storage.readTab(pageKey) !== raw) storage.writeTab(pageKey, raw);
  }
  const key = activeConversationKey(workspaceId);
  if (storage.readTab(key) !== raw) storage.writeTab(key, raw);
}

/**
 * A person chose a conversation (switched, started a new one, continued one
 * from `/chats`): it becomes this page's and this tab's, and the starting
 * point of the next new tab. No other open tab hears of it.
 */
export function chooseActiveConversation(
  storage: ConversationStorage,
  workspaceId: string,
  documentId: string | null,
  conversationId: string | null,
): void {
  recordShownConversation(storage, workspaceId, documentId, conversationId);
  storage.writeSeed(activeConversationKey(workspaceId), JSON.stringify(conversationId));
}
