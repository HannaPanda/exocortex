/**
 * The chat panel's own persisted state, addressable from outside the panel.
 *
 * The active conversation is remembered per workspace, which is what lets a
 * person walk to another page and keep typing into the same transcript. Since
 * issue #69 the `/chats` area writes it too -- "Im Panel fortsetzen" is exactly
 * "put this id where the panel looks for it, then go there" -- so the key is
 * built in one place rather than spelled out twice.
 */

export function activeConversationKey(workspaceId: string | null): string {
  return `exocortex.ai.conversation.${workspaceId ?? 'none'}`;
}

export function parseConversationId(raw: string): string | null {
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'string' ? parsed : null;
}
