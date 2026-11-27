'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { useRowPeekCommands } from '@/components/palette/row-peek-commands';
import { documentHref } from '@/lib/document-href';

import { opensWithNewHistoryStep, peekAddress, peekIdOf } from './row-peek-address';

/**
 * A row of a database opened beside it, as a page in a side panel (issue
 * #239, Notion's "side peek").
 *
 * The open row is the address (`?p=<id>`, see `row-peek-address.ts`), so the
 * table underneath never re-renders for it: its filters, sort, selection and
 * scroll position are simply left alone. The address is changed through the
 * browser's own history API, which Next.js folds into its router without a
 * server round trip.
 */
export interface RowPeek {
  /** The row open beside the page, or `null`. */
  peekId: string | null;
  /**
   * Opens `rowId`, or switches the open panel to it. `selectTitle` is for a
   * row that was just made: its name is focused and selected, ready to be
   * typed over.
   */
  open: (rowId: string, options?: { selectTitle?: boolean }) => void;
  close: () => void;
  /** The row whose title should be selected once it has loaded. */
  selectTitleFor: string | null;
  /** Called by the panel once the title took the focus. */
  titleSelected: () => void;
  workspaceId: string;
}

const RowPeekContext = React.createContext<RowPeek | null>(null);

/**
 * The side panel of the page this is called in, or `null` where there is none
 * (a database rendered outside a document view). Callers fall back to opening
 * the row as its own page.
 */
export function useRowPeek(): RowPeek | null {
  return React.useContext(RowPeekContext);
}

/** Marks every control that opens a row, so the focus can come back to it. */
export const PEEK_TRIGGER_ATTRIBUTE = 'data-peek-trigger';

/**
 * Whether an Escape is meant for something other than the panel: a menu, a
 * popover or a dialog closes first, and a field outside the panel keeps it.
 */
function escapeBelongsElsewhere(target: EventTarget | null, panel: Element | null): boolean {
  if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null) {
    return true;
  }
  if (!(target instanceof HTMLElement)) return false;
  if (panel?.contains(target) === true) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/** Marks the open panel in the DOM; `use-row-actions.tsx` reads it too. */
export const ROW_PEEK_ATTRIBUTE = 'data-row-peek';

export function RowPeekProvider({
  workspaceId,
  documentId,
  children,
}: {
  workspaceId: string;
  /** The page the address names; it is never opened beside itself. */
  documentId: string;
  children: React.ReactNode;
}) {
  const search = useSearchParams();
  const peekId = peekIdOf(search, documentId);
  const current = React.useRef(peekId);
  React.useLayoutEffect(() => {
    current.current = peekId;
  });

  /** Whether the open panel added the step Back would remove. */
  const pushed = React.useRef(false);
  /** Where the focus was when the panel opened, to hand it back on close. */
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const [selectTitleFor, setSelectTitleFor] = React.useState<string | null>(null);

  const open = React.useCallback((rowId: string, options?: { selectTitle?: boolean }): void => {
    const before = current.current;
    if (before === null) {
      const active = document.activeElement;
      returnFocus.current =
        active instanceof HTMLElement && active !== document.body ? active : null;
    }
    if (options?.selectTitle === true) setSelectTitleFor(rowId);
    if (before === rowId) return;
    const address = peekAddress(window.location, rowId);
    if (opensWithNewHistoryStep(before)) {
      window.history.pushState(null, '', address);
      pushed.current = true;
    } else {
      window.history.replaceState(null, '', address);
    }
  }, []);

  const close = React.useCallback((): void => {
    if (current.current === null) return;
    // Back, when opening the panel was a step of its own: closing it and the
    // browser's Back button are then the same thing, and a later Back leaves
    // the database rather than reopening a row.
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
      return;
    }
    window.history.replaceState(null, '', peekAddress(window.location, null));
  }, []);

  // Closed by any route (the button, Escape, Back): the focus goes back to
  // the row the panel showed last, the one the reader was just looking at, or
  // else to whatever opened the panel.
  const previous = React.useRef(peekId);
  React.useEffect(() => {
    const was = previous.current;
    previous.current = peekId;
    if (peekId !== null || was === null) return;
    pushed.current = false;
    const remembered = returnFocus.current;
    returnFocus.current = null;
    const target =
      document.querySelector<HTMLElement>(`[${PEEK_TRIGGER_ATTRIBUTE}="${CSS.escape(was)}"]`) ??
      (remembered?.isConnected === true ? remembered : null);
    // `preventScroll`: the table stays where the reader left it.
    target?.focus({ preventScroll: true });
  }, [peekId]);

  // Escape closes the panel, unless it was meant for something else.
  React.useEffect(() => {
    if (peekId === null) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const panel = document.querySelector(`[${ROW_PEEK_ATTRIBUTE}]`);
      if (escapeBelongsElsewhere(event.target, panel)) return;
      // A title being typed is committed on blur, so it is blurred before the
      // panel and its field go away.
      const active = document.activeElement;
      if (active instanceof HTMLElement && panel?.contains(active) === true) active.blur();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, peekId]);

  useRowPeekCommands({
    open: peekId !== null,
    pageHref: peekId === null ? null : documentHref(workspaceId, peekId, 'PAGE'),
    close,
  });

  const titleSelected = React.useCallback(() => setSelectTitleFor(null), []);
  const value = React.useMemo(
    (): RowPeek => ({ peekId, open, close, selectTitleFor, titleSelected, workspaceId }),
    [close, open, peekId, selectTitleFor, titleSelected, workspaceId],
  );
  return <RowPeekContext.Provider value={value}>{children}</RowPeekContext.Provider>;
}

/**
 * A link to a row that opens it beside the database instead (issue #239).
 *
 * A plain click opens the side panel; anything that means "somewhere else"
 * (Strg or Cmd, Shift, the middle button) stays the browser's, so a row can
 * still go into a new tab. Without a panel to open, it is an ordinary link.
 */
export function RowPeekLink({
  workspaceId,
  rowId,
  className,
  title,
  children,
  testId,
}: {
  workspaceId: string;
  rowId: string;
  className?: string;
  title?: string;
  children: React.ReactNode;
  testId?: string;
}) {
  const peek = useRowPeek();
  return (
    <Link
      href={documentHref(workspaceId, rowId, 'PAGE')}
      className={className}
      title={title}
      data-testid={testId}
      {...{ [PEEK_TRIGGER_ATTRIBUTE]: rowId }}
      aria-current={peek?.peekId === rowId ? 'true' : undefined}
      onClick={(event) => {
        if (peek === null) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        peek.open(rowId);
      }}
    >
      {children}
    </Link>
  );
}
