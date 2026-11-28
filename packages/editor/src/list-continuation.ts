import { Extension } from '@tiptap/core';
import { Fragment, type Node as PmNode } from '@tiptap/pm/model';
import {
  type EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Transaction,
} from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

import { type EditorWords, GERMAN_EDITOR_WORDS } from './editor-words';

/**
 * Continuing a list across a picture, a quote or a table (issue #240).
 *
 * A list, then an image, then an empty line: before this, the only way back
 * into the list was pressing Enter in front of the image, which pushed the
 * image down. Now the empty line offers to continue the list above it. The
 * offer is a preview and nothing else -- a pale marker where the point would
 * stand and a hint in the placeholder -- and only `Tab` takes it. Typing
 * anything else leaves the line the paragraph it is, so prose after a list
 * stays prose, and `- ` still starts a list of its own.
 *
 * The rules, each one deliberate:
 *
 * - The last list before the line counts, not only the block right above it.
 *   At most `LIST_CONTINUATION_MAX_GAP` blocks may stand between the two, and a
 *   heading ends the connection: under a new heading a list belongs to the
 *   new section.
 * - Directly after the list, the new point goes where the last point stands,
 *   nested sub-points included. Across a block it goes to the level of the
 *   list beside that block: a sub-point needs the point above it, and that
 *   point is on the other side of the picture.
 * - An empty line inside a list point, below a picture in that point (what
 *   `Strg+Enter` and an inserted image leave behind), becomes the next point
 *   of the same list, taking whatever follows it in the point along.
 * - A numbered list counts on: a new list after the gap starts at the next
 *   number, and a task stays a task.
 * - Table cells are left alone, because `Tab` moves between cells there.
 *
 * The preview is a decoration, never content (ADR-005): nothing reaches the
 * Yjs state until `Tab`, and that is one transaction, so `Strg+Z` takes it
 * back in one step.
 */
export const LIST_CONTINUATION_MAX_GAP = 2;

/** The list types a line can continue, and the item each of them holds. */
const ITEM_TYPE_OF_LIST: Readonly<Record<string, string>> = {
  bulletList: 'listItem',
  orderedList: 'listItem',
  taskList: 'taskItem',
};

const LIST_ITEM_TYPES = new Set(['listItem', 'taskItem']);

/** Where `Tab` already means something else: the next cell. */
const TAB_OWNING_ANCESTORS = new Set(['tableCell', 'tableHeader']);

export type ListContinuationMarker =
  { kind: 'bullet' } | { kind: 'ordered'; number: number } | { kind: 'task' };

/**
 * The markers change with the depth of a list (issue #250): a bullet is a
 * disc, a circle, a square; a number is 1., a., i.; then the round starts
 * again. The depth counts every list a point stands in, bullets, numbers and
 * tasks alike, because it is the indentation the reader sees, which is also
 * how a browser and a word processor count it. `globals.css` in the web app
 * draws the real markers by the same table; the preview of a continuation
 * (below) has to name the one its level will carry, or the pale marker would
 * promise a disc where a circle appears.
 *
 * CSS cannot count modulo, so the stylesheet spells out
 * `LIST_MARKER_STYLED_DEPTH` levels and every deeper list keeps the last one;
 * `listMarkerLevel` clamps the same way.
 */
export const LIST_MARKER_CYCLE = 3;
export const LIST_MARKER_STYLED_DEPTH = 6;

const BULLET_MARKERS = ['•', '◦', '▪'] as const;

/** Where in the round of markers a list at `depth` (1 = outermost) stands: 0, 1 or 2. */
export function listMarkerLevel(depth: number): number {
  const clamped = Math.min(Math.max(Math.trunc(depth), 1), LIST_MARKER_STYLED_DEPTH);
  return (clamped - 1) % LIST_MARKER_CYCLE;
}

/** CSS `lower-alpha`: a … z, aa, ab …; nothing below 1, where CSS falls back to digits. */
function lowerAlpha(value: number): string | null {
  if (value < 1) return null;
  let rest = value;
  let text = '';
  while (rest > 0) {
    rest -= 1;
    text = String.fromCharCode(97 + (rest % 26)) + text;
    rest = Math.floor(rest / 26);
  }
  return text;
}

const ROMAN: readonly (readonly [number, string])[] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

/** CSS `lower-roman`, defined from 1 to 3999; outside it CSS falls back to digits. */
function lowerRoman(value: number): string | null {
  if (value < 1 || value > 3999) return null;
  let rest = value;
  let text = '';
  for (const [amount, letters] of ROMAN) {
    while (rest >= amount) {
      text += letters;
      rest -= amount;
    }
  }
  return text;
}

/**
 * The text of the marker a point at `depth` carries, as the stylesheet draws
 * it: the bullet of its level, or its number in the level's numbering with the
 * period. A task's marker is its box, which has no text.
 */
export function listMarkerText(marker: ListContinuationMarker, depth: number): string {
  const level = listMarkerLevel(depth);
  if (marker.kind === 'bullet') return BULLET_MARKERS[level] ?? '•';
  if (marker.kind === 'task') return '';
  const number = Math.trunc(marker.number);
  const text = level === 1 ? lowerAlpha(number) : level === 2 ? lowerRoman(number) : String(number);
  return `${text ?? String(number)}.`;
}

/** How the new point is made. Positions are document positions. */
export type ListContinuationAction =
  /** Append a point to the list at `listPos` (the line sits right after it). */
  | { type: 'append'; listPos: number }
  /** Replace the line with a new one-point list of `list`'s kind. */
  | { type: 'newList'; listPos: number }
  /** Move the line out of the point at `itemPos` into a point after it. */
  | { type: 'splitItem'; itemPos: number };

export interface ListContinuation {
  /** The position in front of the empty line. */
  paragraphPos: number;
  action: ListContinuationAction;
  marker: ListContinuationMarker;
  /**
   * The list levels the new point's text will stand deeper than the line's
   * text does now, outermost first. Only the preview needs it: it is what
   * indents the line so the pale marker stands where the real one will.
   */
  levels: readonly ('list' | 'task')[];
  /**
   * How many lists the new point will stand in, itself included (1 = a point
   * of an outermost list). It decides which marker the preview shows.
   */
  depth: number;
}

function isList(node: PmNode): boolean {
  return node.type.name in ITEM_TYPE_OF_LIST;
}

function levelOf(list: PmNode): 'list' | 'task' {
  return list.type.name === 'taskList' ? 'task' : 'list';
}

function startOf(list: PmNode): number {
  const start: unknown = list.attrs.start;
  return typeof start === 'number' && Number.isFinite(start) ? start : 1;
}

/** The marker a point appended at the end of `list` would carry. */
function nextMarkerOf(list: PmNode): ListContinuationMarker {
  if (list.type.name === 'taskList') return { kind: 'task' };
  if (list.type.name === 'orderedList') {
    return { kind: 'ordered', number: startOf(list) + list.childCount };
  }
  return { kind: 'bullet' };
}

/**
 * Follows the last point of `list` down into the sub-list that ends it, as far
 * as that goes: the list the last point of all stands in.
 */
function deepestLastList(
  list: PmNode,
  listPos: number,
): { list: PmNode; pos: number; levels: ('list' | 'task')[] } {
  let current = list;
  let pos = listPos;
  const levels: ('list' | 'task')[] = [levelOf(list)];
  for (;;) {
    const item = current.lastChild;
    const tail = item?.lastChild;
    if (item == null || tail == null || item.childCount < 2 || !isList(tail)) break;
    const itemPos = pos + 1 + current.content.size - item.nodeSize;
    pos = itemPos + 1 + item.content.size - tail.nodeSize;
    current = tail;
    levels.push(levelOf(tail));
  }
  return { list: current, pos, levels };
}

/**
 * Whether the empty paragraph at `paragraphPos` can continue a list above it,
 * and how. `null` when it cannot: the block is not an empty paragraph, it is a
 * list point's own text already, it sits in a table cell, or no list is close
 * enough above it.
 */
export function findListContinuation(doc: PmNode, paragraphPos: number): ListContinuation | null {
  const paragraph = doc.nodeAt(paragraphPos);
  if (paragraph?.type.name !== 'paragraph' || paragraph.content.size > 0) return null;
  const $pos = doc.resolve(paragraphPos);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (TAB_OWNING_ANCESTORS.has($pos.node(depth).type.name)) return null;
  }
  const parent = $pos.parent;
  const index = $pos.index();
  let enclosingLists = 0;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if (isList($pos.node(depth))) enclosingLists += 1;
  }
  const insideItem = LIST_ITEM_TYPES.has(parent.type.name);
  // The first paragraph of a point is that point's text: it is a list point.
  if (insideItem && index === 0) return null;

  let gap = 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    const sibling = parent.child(at);
    if (isList(sibling)) {
      const listPos = $pos.posAtIndex(at);
      if (gap === 0) {
        const deepest = deepestLastList(sibling, listPos);
        return {
          paragraphPos,
          action: { type: 'append', listPos: deepest.pos },
          marker: nextMarkerOf(deepest.list),
          levels: deepest.levels,
          depth: enclosingLists + deepest.levels.length,
        };
      }
      return {
        paragraphPos,
        action: { type: 'newList', listPos },
        marker: nextMarkerOf(sibling),
        levels: [levelOf(sibling)],
        depth: enclosingLists + 1,
      };
    }
    if (sibling.type.name === 'heading') return null;
    if (insideItem && at === 0) {
      // Reached the point's own text: the line becomes the next point of the
      // list this point stands in, at its level.
      const list = $pos.node($pos.depth - 1);
      const itemIndex = $pos.index($pos.depth - 1);
      const marker: ListContinuationMarker =
        list.type.name === 'orderedList'
          ? { kind: 'ordered', number: startOf(list) + itemIndex + 1 }
          : list.type.name === 'taskList'
            ? { kind: 'task' }
            : { kind: 'bullet' };
      return {
        paragraphPos,
        action: { type: 'splitItem', itemPos: $pos.before() },
        marker,
        levels: [],
        depth: enclosingLists,
      };
    }
    gap += 1;
    if (gap > LIST_CONTINUATION_MAX_GAP) return null;
  }
  return null;
}

/** The continuation the caret stands in, if it stands in an empty line that has one. */
export function listContinuationAtSelection(state: EditorState): ListContinuation | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  if ($from.parent.type.name !== 'paragraph' || $from.depth === 0) return null;
  return findListContinuation(state.doc, $from.before());
}

/** Fresh attributes of a node's type: a copy must not carry its source's block id. */
function attrsWithoutId(
  node: PmNode,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const attrs: Record<string, unknown> = { ...node.attrs, ...overrides };
  if ('blockId' in attrs) attrs.blockId = null;
  return attrs;
}

/**
 * The one transaction that turns the empty line into the next point. The line
 * itself travels into the point with its block id, so a reference to it stays
 * good; the caret ends up in it.
 */
export function continueListTransaction(
  state: EditorState,
  continuation: ListContinuation,
): Transaction | null {
  const { doc, schema } = state;
  const { paragraphPos, action } = continuation;
  const paragraph = doc.nodeAt(paragraphPos);
  if (paragraph == null) return null;
  const tr = state.tr;

  if (action.type === 'append') {
    const list = doc.nodeAt(action.listPos);
    const itemType =
      list == null ? undefined : schema.nodes[ITEM_TYPE_OF_LIST[list.type.name] ?? ''];
    if (list == null || itemType == null) return null;
    const listEnd = action.listPos + list.nodeSize - 1;
    // The list lies before the line, so deleting the line moves nothing in it.
    tr.delete(paragraphPos, paragraphPos + paragraph.nodeSize);
    tr.insert(listEnd, itemType.create(null, paragraph));
    tr.setSelection(TextSelection.create(tr.doc, listEnd + 2));
  } else if (action.type === 'newList') {
    const source = doc.nodeAt(action.listPos);
    const listType = source == null ? undefined : schema.nodes[source.type.name];
    const itemType =
      source == null ? undefined : schema.nodes[ITEM_TYPE_OF_LIST[source.type.name] ?? ''];
    if (source == null || listType == null || itemType == null) return null;
    const overrides =
      source.type.name === 'orderedList' ? { start: startOf(source) + source.childCount } : {};
    const list = listType.create(
      attrsWithoutId(source, overrides),
      itemType.create(null, paragraph),
    );
    tr.replaceWith(paragraphPos, paragraphPos + paragraph.nodeSize, list);
    tr.setSelection(TextSelection.create(tr.doc, paragraphPos + 3));
  } else {
    const item = doc.nodeAt(action.itemPos);
    if (item == null) return null;
    const itemEnd = action.itemPos + item.nodeSize;
    // The line and everything after it in the point move into the new point,
    // so nothing changes its order.
    const moved = doc.slice(paragraphPos, itemEnd - 1).content;
    const next = item.type.create(
      attrsWithoutId(item, item.type.name === 'taskItem' ? { checked: false } : {}),
      Fragment.from(moved),
    );
    tr.delete(paragraphPos, itemEnd - 1);
    const insertAt = tr.mapping.map(itemEnd);
    tr.insert(insertAt, next);
    tr.setSelection(TextSelection.create(tr.doc, insertAt + 2));
  }
  return tr.scrollIntoView();
}

/**
 * `Backspace` in an empty line right below a list (issue #302): the line goes
 * and the caret lands at the end of the list's last point, at whatever depth
 * that point stands. One press, one visible step, one undo step.
 *
 * ProseMirror's own `joinBackward` instead wrapped the line into a new, empty
 * point at the end of the list, and the next press joined that point into the
 * one above as a second paragraph. Both times the line stood exactly where the
 * pale marker of the continuation preview had drawn it, so two presses did
 * nothing a reader could see, and a nested list added one more. The rule holds
 * below every list, also where no preview is offered (a table cell), and only
 * for a line without content: text below a list keeps the old join.
 */
export function backspaceBelowListTransaction(state: EditorState): Transaction | null {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { $from } = selection;
  if ($from.depth === 0 || $from.parent.type.name !== 'paragraph') return null;
  if ($from.parent.content.size > 0) return null;
  const container = $from.node($from.depth - 1);
  const index = $from.index($from.depth - 1);
  const above = index > 0 ? container.child(index - 1) : null;
  if (above === null || !isList(above)) return null;
  if (!container.canReplace(index, index + 1)) return null;
  const lineStart = $from.before();
  // The list lies before the line, so deleting the line moves nothing in it.
  const tr = state.tr.delete(lineStart, $from.after());
  const listContentEnd = lineStart - 1;
  const target = Selection.findFrom(tr.doc.resolve(listContentEnd), -1);
  if (target === null) return null;
  return tr.setSelection(target).scrollIntoView();
}

const listContinuationKey = new PluginKey('listContinuation');

/**
 * The preview: the empty line the caret stands in, indented to where the new
 * point's text will be, with the pale marker in front of it and the hint as
 * its placeholder. Drawn by `globals.css` in the web app from these
 * attributes; the colours are the placeholder's.
 */
function previewDecorations(
  state: EditorState,
  words: EditorWords['listContinuation'],
): DecorationSet {
  const continuation = listContinuationAtSelection(state);
  if (continuation === null) return DecorationSet.empty;
  const paragraph = state.doc.nodeAt(continuation.paragraphPos);
  if (paragraph == null) return DecorationSet.empty;
  const lists = continuation.levels.filter((level) => level === 'list').length;
  const tasks = continuation.levels.length - lists;
  return DecorationSet.create(state.doc, [
    Decoration.node(continuation.paragraphPos, continuation.paragraphPos + paragraph.nodeSize, {
      class: 'exocortex-list-ghost',
      'data-list-ghost': continuation.marker.kind,
      'data-list-ghost-marker': listMarkerText(continuation.marker, continuation.depth),
      'data-list-ghost-hint': continuation.marker.kind === 'task' ? words.taskHint : words.hint,
      style: `--exocortex-list-ghost-lists: ${lists}; --exocortex-list-ghost-tasks: ${tasks}`,
    }),
  ]);
}

export const ListContinuation = Extension.create<{ words: EditorWords }>({
  name: 'listContinuation',

  // Ahead of the list item's own `Tab` (sink the point): in an empty line
  // below a picture inside a point, `Tab` continues the list instead, which is
  // what the hint on that line says. Everywhere else it returns false and the
  // key goes on to whoever owned it before.
  priority: 1000,

  addOptions() {
    return { words: GERMAN_EDITOR_WORDS };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const words = this.options.words.listContinuation;
    return [
      new Plugin({
        key: listContinuationKey,
        props: {
          decorations: (state) =>
            editor.isEditable ? previewDecorations(state, words) : DecorationSet.empty,
        },
      }),
    ];
  },

  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (!editor.isEditable) return false;
        const continuation = listContinuationAtSelection(editor.state);
        if (continuation === null) return false;
        const tr = continueListTransaction(editor.state, continuation);
        if (tr === null) return false;
        editor.view.dispatch(tr);
        return true;
      },
      // Ahead of the core keymap's `joinBackward`, which would wrap the line
      // into an empty point of the list instead of removing it.
      Backspace: ({ editor }) => {
        if (!editor.isEditable) return false;
        const tr = backspaceBelowListTransaction(editor.state);
        if (tr === null) return false;
        editor.view.dispatch(tr);
        return true;
      },
    };
  },
});
