/**
 * Which workspace the chat panel runs in (issue #234).
 *
 * Inside a workspace the route names it. On a page somebody shared with the
 * reader (`/geteilt/<id>`) it does not, and the page's own workspace is one
 * the reader is not a member of: the chat then runs in one of the reader's
 * own workspaces, on its key and its budget, and the shared page is the open
 * page of that conversation. What the assistant may do on that page is decided
 * by the API on every call, as the reader, against the grant; nothing here
 * widens it.
 *
 * Pure, so the decision is tested without a browser.
 */

/** The part of a workspace the decision reads. */
export interface ChatWorkspaceCandidate {
  id: string;
  name: string;
  /** An agent memory area (ADR-023) belongs to the agents, so no chat runs there. */
  isMemory: boolean;
}

export type ChatWorkspace =
  /** Not decidable yet: the page or the workspace list is still loading. */
  | { kind: 'pending' }
  /** Nothing to run in: no workspace in the route and no page to start from. */
  | { kind: 'none' }
  /** A page shared with somebody who has no workspace of their own to pay for the chat. */
  | { kind: 'no_own_workspace' }
  /** The route's workspace, or the page's own one when the reader is a member there. */
  | { kind: 'member'; workspaceId: string }
  /** A shared page: the chat runs in one of the reader's own workspaces. */
  | {
      kind: 'shared';
      workspaceId: string;
      workspaceName: string;
      /** Every workspace the reader could run it in instead, in their own order. */
      choices: readonly { id: string; name: string }[];
    };

export function resolveChatWorkspace(input: {
  routeWorkspaceId: string | null;
  documentId: string | null;
  /** The open page's workspace; `undefined` while it loads, `null` when it cannot be read. */
  documentWorkspaceId: string | null | undefined;
  /** The reader's workspaces in their own order; `undefined` while they load. */
  workspaces: readonly ChatWorkspaceCandidate[] | undefined;
  /** The workspace the reader chose for shared pages last time, if any. */
  remembered: string | null;
}): ChatWorkspace {
  if (input.routeWorkspaceId !== null) {
    return { kind: 'member', workspaceId: input.routeWorkspaceId };
  }
  if (input.documentId === null || input.documentWorkspaceId === null) return { kind: 'none' };
  if (input.documentWorkspaceId === undefined || input.workspaces === undefined) {
    return { kind: 'pending' };
  }

  // A member who followed a share link talks about the page where it lives:
  // the API refuses a page of a workspace the caller belongs to as the
  // context of a conversation somewhere else.
  const documentWorkspaceId = input.documentWorkspaceId;
  if (input.workspaces.some((workspace) => workspace.id === documentWorkspaceId)) {
    return { kind: 'member', workspaceId: documentWorkspaceId };
  }

  const choices = input.workspaces
    .filter((workspace) => !workspace.isMemory)
    .map((workspace) => ({ id: workspace.id, name: workspace.name }));
  const chosen = choices.find((workspace) => workspace.id === input.remembered) ?? choices[0];
  if (chosen === undefined) return { kind: 'no_own_workspace' };
  return { kind: 'shared', workspaceId: chosen.id, workspaceName: chosen.name, choices };
}

/** Where the reader's choice for shared pages is remembered, per browser. */
export const SHARED_CHAT_WORKSPACE_KEY = 'exocortex.ai.sharedChatWorkspace';

export function parseWorkspaceId(raw: string): string | null {
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'string' ? parsed : null;
}
