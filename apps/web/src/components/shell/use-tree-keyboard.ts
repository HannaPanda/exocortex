'use client';

import * as React from 'react';

import { type DocumentTreeNode } from '@exocortex/contracts';

import { type ExpandedState, type VisibleRow, visibleRows } from './page-tree-state';

/** The keyboard half of dragging, which was here before the tree pattern was. */
const NUDGE_KEYS: Readonly<Record<string, 'up' | 'down' | 'in' | 'out'>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowRight: 'in',
  ArrowLeft: 'out',
};

/** The keys that move focus rather than doing something to a page. */
const MOVE_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']);

export interface TreeKeyboard {
  /** The one row that holds the tree's single tab stop. */
  tabStopId: string | null;
  onRowKeyDown: (event: React.KeyboardEvent<HTMLElement>, documentId: string) => void;
  onRowFocus: (documentId: string) => void;
}

/**
 * Which row a movement key lands on, or `null` when it lands nowhere.
 *
 * Right and left are only asked once folding has had its turn: by the time this
 * runs, right means "step into an already unfolded branch" and left means "step
 * back out to the parent".
 */
function focusTargetFor(key: string, rows: readonly VisibleRow[], index: number): string | null {
  const row = rows[index];
  if (row === undefined) return null;
  switch (key) {
    case 'ArrowDown':
      return rows[index + 1]?.id ?? null;
    case 'ArrowUp':
      return rows[index - 1]?.id ?? null;
    // The first child is simply the row after an unfolded one, which is what
    // makes stepping in an index lookup rather than a search.
    case 'ArrowRight':
      return row.isOpen ? (rows[index + 1]?.id ?? null) : null;
    case 'ArrowLeft':
      return row.isOpen ? null : row.parentId;
    case 'Home':
      return rows[0]?.id ?? null;
    case 'End':
      return rows[rows.length - 1]?.id ?? null;
    default:
      return null;
  }
}

type FoldMany = 'siblings' | 'open-subtree' | 'close-subtree' | 'nothing';

/**
 * The keys that fold or unfold more than one row, or `null` for any other key.
 *
 * `*` is a shifted key on most layouts, so it is matched by what it types and
 * before the Shift chords. A Shift chord on a row without pages below it is
 * still claimed, so it does not fall through to stepping and move focus.
 */
function foldManyFor(event: React.KeyboardEvent<HTMLElement>, row: VisibleRow): FoldMany | null {
  if (event.key === '*') return 'siblings';
  if (!event.shiftKey || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return null;
  if (!row.hasChildren) return 'nothing';
  return event.key === 'ArrowRight' ? 'open-subtree' : 'close-subtree';
}

/**
 * Opens the row's own menu from the keyboard.
 *
 * The menu is a `ContextMenu`, so what opens it is a `contextmenu` event on the
 * row. A browser fires one for the Menu key and for Shift + F10, but at the
 * element that has focus, which is the tree item rather than the row inside it,
 * and an event travels up rather than down. So the key is caught here and the
 * event is made on the row itself. The position is the row's own left edge: a
 * menu that opens at 0,0 because a key press carries no coordinates would be a
 * menu in the corner of the screen.
 */
function openRowMenu(item: HTMLElement): void {
  const row = item.querySelector<HTMLElement>('[data-tree-row]');
  if (row === null) return;
  const box = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(box.left + 16),
      clientY: Math.round(box.bottom),
    }),
  );
}

/**
 * The tree's keyboard: one way in, then arrow keys.
 *
 * Every row used to hold four tab stops -- the chevron, the symbol, the link
 * and "create a child page" -- so reaching the tenth page meant forty presses
 * of Tab, in a product whose first design principle is that anything doable
 * with the keyboard must be. The tree now behaves the way the platform's own
 * trees do (WAI-ARIA `tree`): a single tab stop that remembers where you were,
 * arrows to move, right and left to unfold and fold, Home and End for the two
 * ends, Enter to open the page.
 *
 * What that costs is the three buttons inside a row, which are reachable by
 * pointer and by the row's own menu rather than by Tab. That is the trade the
 * pattern is built on -- a composite widget owns its arrow keys and hands out
 * one tab stop -- and nothing is lost: every one of the three is in the menu,
 * which opens with the Menu key, with Shift + F10, with a right click and with
 * a long press.
 *
 * `Alt` plus an arrow stays what it was, the keyboard half of dragging, and is
 * checked first so unfolding never swallows a move.
 *
 * Two keys work on more than one row. `*` unfolds every sibling of the row, as
 * the WAI-ARIA pattern defines it; `Shift` with right or left unfolds or folds
 * the row's whole subtree, which the pattern leaves open and which is the one
 * people ask for in a deep workspace. Folding everything at once is the button
 * in the header, because it needs no row to start from.
 */
export function useTreeKeyboard({
  containerRef,
  nodes,
  expanded,
  activeDocumentId,
  toggle,
  setSubtreeOpen,
  expandSiblingsOf,
  nudge,
  openDocument,
}: {
  containerRef: React.RefObject<HTMLUListElement | null>;
  nodes: readonly DocumentTreeNode[];
  expanded: ExpandedState;
  activeDocumentId: string | undefined;
  toggle: (documentId: string) => void;
  setSubtreeOpen: (documentId: string, open: boolean) => void;
  expandSiblingsOf: (documentId: string) => void;
  nudge: (documentId: string, direction: 'up' | 'down' | 'in' | 'out') => void;
  openDocument: (documentId: string) => void;
}): TreeKeyboard {
  const [focusedId, setFocusedId] = React.useState<string | null>(null);

  const rows = React.useMemo(() => visibleRows(nodes, expanded), [nodes, expanded]);

  /**
   * Where Tab lands: the row last focused, else the page that is open, else the
   * first one. Reading it out of the current rows rather than trusting the
   * stored id is what keeps the tab stop from vanishing when the row it named
   * gets folded away or archived by somebody else.
   */
  const tabStopId =
    rows.find((row) => row.id === focusedId)?.id ??
    rows.find((row) => row.id === activeDocumentId)?.id ??
    rows[0]?.id ??
    null;

  const focusRow = (documentId: string): void => {
    setFocusedId(documentId);
    containerRef.current
      ?.querySelector<HTMLElement>(`[data-tree-item="${CSS.escape(documentId)}"]`)
      ?.focus();
  };

  const foldMany = (many: FoldMany, documentId: string): void => {
    if (many === 'siblings') expandSiblingsOf(documentId);
    else if (many !== 'nothing') setSubtreeOpen(documentId, many === 'open-subtree');
  };

  const onRowKeyDown = (event: React.KeyboardEvent<HTMLElement>, documentId: string): void => {
    const index = rows.findIndex((row) => row.id === documentId);
    const row = rows[index];
    if (row === undefined) return;

    /**
     * This row answers the key, and no other.
     *
     * A tree item sits inside its parent tree item, so a key pressed on a child
     * reaches every ancestor's handler on the way up. Without this, stepping
     * out of a child with the left arrow moved focus to the parent and then let
     * the parent fold itself shut -- one press doing two things, the second of
     * them invisible until the branch was gone.
     */
    const claim = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };

    const direction = event.altKey ? NUDGE_KEYS[event.key] : undefined;
    if (direction !== undefined) {
      claim();
      nudge(documentId, direction);
      return;
    }
    // Everything below is a bare key. A browser shortcut carrying a modifier
    // keeps its meaning here rather than being eaten by the tree.
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    const many = foldManyFor(event, row);
    if (many !== null) {
      claim();
      foldMany(many, documentId);
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      claim();
      openDocument(documentId);
      return;
    }

    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      claim();
      openRowMenu(event.currentTarget);
      return;
    }

    // Folding has the first claim on right and left; stepping is what is left
    // over once there is nothing to unfold or fold.
    const folds =
      (event.key === 'ArrowRight' && row.hasChildren && !row.isOpen) ||
      (event.key === 'ArrowLeft' && row.isOpen);
    if (folds) {
      claim();
      toggle(documentId);
      return;
    }

    if (!MOVE_KEYS.has(event.key)) return;
    claim();
    const target = focusTargetFor(event.key, rows, index);
    if (target !== null) focusRow(target);
  };

  // A click lands on the link inside the row, not on the row, and focus follows
  // the click. Without this the tab stop would stay wherever the arrows last
  // left it, and Tab would then jump somewhere other than the row being used.
  const onRowFocus = React.useCallback((documentId: string) => setFocusedId(documentId), []);

  return { tabStopId, onRowKeyDown, onRowFocus };
}
