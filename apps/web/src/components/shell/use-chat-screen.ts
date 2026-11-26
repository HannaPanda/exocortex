'use client';

import * as React from 'react';

export interface ChatScreen {
  /** The chat has the screen and the page beside it is folded away. */
  fills: boolean;
  change: (expanded: boolean) => void;
}

/**
 * Whether the chat has the screen (issue #288).
 *
 * Not remembered: it belongs to what is on screen right now, so going
 * somewhere else and closing the panel both give the page back. Both are
 * adjusted during render rather than in an effect, the same idiom the run
 * tracker uses when the conversation changes.
 */
export function useChatScreen({
  pathname,
  contextOpen,
  openContext,
  showAssistant,
}: {
  pathname: string | null;
  contextOpen: boolean;
  openContext: () => void;
  /** Brings the assistant's tab forward, which on a page is not always the one shown. */
  showAssistant: () => void;
}): ChatScreen {
  const [expanded, setExpanded] = React.useState(false);
  const [expandedOn, setExpandedOn] = React.useState(pathname);
  if (expandedOn !== pathname) {
    setExpandedOn(pathname);
    setExpanded(false);
  }
  if (expanded && !contextOpen) setExpanded(false);

  const change = React.useCallback(
    (next: boolean) => {
      if (next) {
        showAssistant();
        // Opened first: a render that saw the chat expanded inside a closed
        // panel would fold it straight back (see above).
        if (!contextOpen) openContext();
      }
      setExpanded(next);
    },
    [contextOpen, openContext, showAssistant],
  );

  return { fills: expanded && contextOpen, change };
}
