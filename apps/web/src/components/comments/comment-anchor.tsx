'use client';

import * as React from 'react';

/**
 * What the editor asks the comment panel to do.
 *
 * `compose` comes from "Kommentieren" in the selection toolbar: a new thread on
 * the block the caret sits in, with the selected text as the quote. `focus`
 * comes from clicking a marker in the text: scroll to the thread that already
 * hangs there.
 */
export interface CommentAnchorRequest {
  kind: 'compose' | 'focus';
  documentId: string;
  /** `null` only ever for `compose`, meaning a remark about the whole page. */
  blockId: string | null;
  /** The commented passage, stored with a new thread so it survives the block. */
  quote: string;
  /**
   * Bumped on every request. The panel keys on this, not on the block: asking
   * twice for the same block has to open the composer twice.
   */
  requestId: number;
}

/** What the panel asks the editor to do: bring a block into view. */
export interface RevealBlockRequest {
  blockId: string;
  requestId: number;
}

interface CommentAnchorContextValue {
  request: CommentAnchorRequest | null;
  compose: (input: { documentId: string; blockId: string | null; quote: string }) => void;
  focus: (input: { documentId: string; blockId: string }) => void;
  clearRequest: () => void;
  reveal: RevealBlockRequest | null;
  revealBlock: (blockId: string) => void;
}

const CommentAnchorContext = React.createContext<CommentAnchorContextValue | null>(null);

/**
 * Carries a commented spot between the editor and the comment panel.
 *
 * The same shape as `AiSelectionProvider` next door and for the same reason:
 * the two live in different subtrees of the shell, and the smallest thing they
 * can share is one pending request each way. It holds no comment data — that is
 * server state and belongs to TanStack Query — only "which spot is meant".
 */
export function CommentAnchorProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = React.useState<CommentAnchorRequest | null>(null);
  const [reveal, setReveal] = React.useState<RevealBlockRequest | null>(null);
  const counter = React.useRef(0);

  const compose = React.useCallback(
    (input: { documentId: string; blockId: string | null; quote: string }) => {
      counter.current += 1;
      setRequest({ ...input, kind: 'compose', requestId: counter.current });
    },
    [],
  );

  const focus = React.useCallback((input: { documentId: string; blockId: string }) => {
    counter.current += 1;
    setRequest({ ...input, kind: 'focus', quote: '', requestId: counter.current });
  }, []);

  const clearRequest = React.useCallback(() => setRequest(null), []);

  const revealBlock = React.useCallback((blockId: string) => {
    counter.current += 1;
    setReveal({ blockId, requestId: counter.current });
  }, []);

  const value = React.useMemo(
    () => ({ request, compose, focus, clearRequest, reveal, revealBlock }),
    [request, compose, focus, clearRequest, reveal, revealBlock],
  );
  return <CommentAnchorContext.Provider value={value}>{children}</CommentAnchorContext.Provider>;
}

export function useCommentAnchor(): CommentAnchorContextValue {
  const context = React.useContext(CommentAnchorContext);
  if (context === null) {
    throw new Error('useCommentAnchor must be used inside a CommentAnchorProvider');
  }
  return context;
}
