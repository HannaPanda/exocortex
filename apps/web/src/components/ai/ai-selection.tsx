'use client';

import * as React from 'react';

/** A passage the user handed from the editor to the chat, waiting to be sent. */
export interface PendingSelection {
  /** The page it was taken from. The panel drops it when the route moves elsewhere. */
  documentId: string;
  blockIds: string[];
  text: string;
  /**
   * Bumped on every hand-over. The shell opens the context panel in response,
   * and needs to notice a second hand-over of the *same* passage too.
   */
  requestId: number;
}

/** A passage as the editor reports it: where it is, which blocks, which words. */
export interface SelectedPassage {
  documentId: string;
  blockIds: string[];
  text: string;
}

interface AiSelectionContextValue {
  selection: PendingSelection | null;
  handOver: (input: SelectedPassage) => void;
  /**
   * Drops the pending selection. `sent` also drops the offer of what is still
   * marked: right after the passage went out, offering the same words again
   * would read as "this did not go". The offer returns when the selection
   * moves; removing the chip by hand keeps it, since nothing was sent.
   */
  clear: (options?: { sent?: boolean }) => void;
}

interface LiveSelectionContextValue {
  /** What is marked in the editor right now, or `null` when nothing is. */
  live: SelectedPassage | null;
  report: (passage: SelectedPassage | null) => void;
  /**
   * Forgets the live passage if it is one of `documentId`'s. An editor going
   * away must not wipe what another one (a row opened beside it) reported.
   */
  withdraw: (documentId: string) => void;
}

const AiSelectionContext = React.createContext<AiSelectionContextValue | null>(null);
const LiveSelectionContext = React.createContext<LiveSelectionContextValue | null>(null);

/**
 * Carries a selection from the editor's bubble menu to the AI panel.
 *
 * The two live in different subtrees of the shell (`AppMain` and the context
 * panel), so this is the smallest shared thing between them. It holds one
 * pending selection, not a history: handing over a second passage replaces the
 * first, which matches what the chip row can show.
 *
 * Nothing here sends anything. The selection is a *proposal* until the user
 * submits a message, and it is visible as a chip the whole time -- what stands
 * in the chip row goes out, what does not stand there does not.
 *
 * Beside it sits what is marked in the editor right now (issue #249). That is
 * a second, weaker thing on purpose: the chip row offers it ("Markierung
 * mitschicken"), and only taking the offer turns it into the pending
 * selection above. A passage that travelled just because it happened to be
 * marked when somebody pressed Enter would be content leaving the page
 * without anybody deciding it should. It has its own context so that a
 * caret moving through the text re-renders the chip row, not the shell.
 */
export function AiSelectionProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = React.useState<PendingSelection | null>(null);
  const requestCounter = React.useRef(0);
  const [live, setLive] = React.useState<SelectedPassage | null>(null);

  const handOver = React.useCallback((input: SelectedPassage) => {
    requestCounter.current += 1;
    setSelection({
      documentId: input.documentId,
      blockIds: input.blockIds,
      text: input.text,
      requestId: requestCounter.current,
    });
  }, []);

  const clear = React.useCallback((options?: { sent?: boolean }) => {
    setSelection(null);
    if (options?.sent === true) setLive(null);
  }, []);

  const report = React.useCallback((passage: SelectedPassage | null) => {
    setLive((previous) => (samePassage(previous, passage) ? previous : passage));
  }, []);

  const withdraw = React.useCallback((documentId: string) => {
    setLive((previous) => (previous?.documentId === documentId ? null : previous));
  }, []);

  const value = React.useMemo(() => ({ selection, handOver, clear }), [selection, handOver, clear]);
  const liveValue = React.useMemo(() => ({ live, report, withdraw }), [live, report, withdraw]);
  return (
    <AiSelectionContext.Provider value={value}>
      <LiveSelectionContext.Provider value={liveValue}>{children}</LiveSelectionContext.Provider>
    </AiSelectionContext.Provider>
  );
}

/** Whether two reports name the same passage, so a re-report changes nothing. */
export function samePassage(a: SelectedPassage | null, b: SelectedPassage | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.documentId === b.documentId &&
    a.text === b.text &&
    a.blockIds.length === b.blockIds.length &&
    a.blockIds.every((id, index) => id === b.blockIds[index])
  );
}

export function useAiSelection(): AiSelectionContextValue {
  const context = React.useContext(AiSelectionContext);
  if (context === null) {
    throw new Error('useAiSelection must be used inside an AiSelectionProvider');
  }
  return context;
}

/**
 * What is marked in the editor right now, and the way to say so.
 *
 * `null` outside the provider rather than a throw: the editor is also mounted
 * where there is no assistant to hand anything to, and there it simply
 * reports to nobody.
 */
export function useLiveSelection(): LiveSelectionContextValue | null {
  return React.useContext(LiveSelectionContext);
}

/** Whether `handOver` can be called here, for surfaces mounted outside the shell too. */
export function useOptionalAiSelection(): AiSelectionContextValue | null {
  return React.useContext(AiSelectionContext);
}
