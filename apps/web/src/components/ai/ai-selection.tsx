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

interface AiSelectionContextValue {
  selection: PendingSelection | null;
  handOver: (input: { documentId: string; blockIds: string[]; text: string }) => void;
  clear: () => void;
}

const AiSelectionContext = React.createContext<AiSelectionContextValue | null>(null);

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
 */
export function AiSelectionProvider({ children }: { children: React.ReactNode }) {
  const [selection, setSelection] = React.useState<PendingSelection | null>(null);
  const requestCounter = React.useRef(0);

  const handOver = React.useCallback(
    (input: { documentId: string; blockIds: string[]; text: string }) => {
      requestCounter.current += 1;
      setSelection({ ...input, requestId: requestCounter.current });
    },
    [],
  );

  const clear = React.useCallback(() => setSelection(null), []);

  const value = React.useMemo(
    () => ({ selection, handOver, clear }),
    [selection, handOver, clear],
  );
  return <AiSelectionContext.Provider value={value}>{children}</AiSelectionContext.Provider>;
}

export function useAiSelection(): AiSelectionContextValue {
  const context = React.useContext(AiSelectionContext);
  if (context === null) {
    throw new Error('useAiSelection must be used inside an AiSelectionProvider');
  }
  return context;
}
