'use client';

import * as React from 'react';

/** A first message typed somewhere other than the chat, waiting for the chat to send it. */
export interface PendingChatStart {
  workspaceId: string;
  text: string;
  /** Bumped on every start, so the shell and the panel each act on it exactly once. */
  requestId: number;
  /** When it was asked for. A start nobody picked up soon is dropped, never sent later. */
  askedAt: number;
}

/** How long a start waits for the panel that is about to mount. */
const PENDING_MS = 10_000;

interface ChatStartContextValue {
  pending: PendingChatStart | null;
  start: (input: { workspaceId: string; text: string }) => void;
  /** Takes the start out of the queue; true only for the one caller that got it. */
  take: (requestId: number) => boolean;
}

const ChatStartContext = React.createContext<ChatStartContextValue | null>(null);

/**
 * Carries a question typed on the workspace's start page to the AI panel
 * (issue #288).
 *
 * The field on the start page and the panel live in different subtrees of the
 * shell, like the editor's selection and the panel (`ai-selection.tsx`), so
 * this is the same kind of small shared slot. The field does not post the
 * message itself: the panel is the one place that creates a conversation,
 * posts into it and follows the run it starts, and a run the panel did not
 * start is a run it would not stream.
 */
export function ChatStartProvider({
  onStart,
  children,
}: {
  /** What the shell does to put the chat on screen, in the same event as the start. */
  onStart: () => void;
  children: React.ReactNode;
}) {
  const [pending, setPending] = React.useState<PendingChatStart | null>(null);
  const counter = React.useRef(0);
  const taken = React.useRef<number | null>(null);
  const latestOnStart = React.useRef(onStart);
  React.useLayoutEffect(() => {
    latestOnStart.current = onStart;
  });

  const start = React.useCallback((input: { workspaceId: string; text: string }) => {
    counter.current += 1;
    setPending({ ...input, requestId: counter.current, askedAt: Date.now() });
    latestOnStart.current();
  }, []);

  const take = React.useCallback((requestId: number): boolean => {
    if (taken.current === requestId) return false;
    taken.current = requestId;
    setPending((current) => (current?.requestId === requestId ? null : current));
    return true;
  }, []);

  const value = React.useMemo(() => ({ pending, start, take }), [pending, start, take]);
  return <ChatStartContext.Provider value={value}>{children}</ChatStartContext.Provider>;
}

export function useChatStart(): ChatStartContextValue {
  const context = React.useContext(ChatStartContext);
  if (context === null) {
    throw new Error('useChatStart must be used inside a ChatStartProvider');
  }
  return context;
}

/** Whether a pending start is still one to act on, for the panel of `workspaceId`. */
export function isChatStartFor(
  pending: PendingChatStart | null,
  workspaceId: string,
  now: number,
): pending is PendingChatStart {
  return (
    pending !== null && pending.workspaceId === workspaceId && now - pending.askedAt < PENDING_MS
  );
}

/**
 * Sends the question the start page handed over, once, from the panel of the
 * workspace it was typed in.
 */
export function useStartedChat(workspaceId: string, send: (text: string) => void): void {
  const { pending, take } = useChatStart();
  const sendLatest = React.useEffectEvent(send);
  React.useEffect(() => {
    if (!isChatStartFor(pending, workspaceId, Date.now())) return;
    if (take(pending.requestId)) sendLatest(pending.text);
  }, [pending, take, workspaceId]);
}
