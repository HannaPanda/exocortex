import { type DecorationAttrs } from '@tiptap/pm/view';

import { PRESENCE_COLORS } from '@/components/shell/document-session';

/**
 * How another person's caret, name tab and selection are drawn.
 *
 * Tiptap's own renderer only accepts a colour written as `#rrggbb` and turns
 * anything else into `transparent`. Presence colours are tokens
 * (`var(--presence-n)`), so every remote caret was invisible, its name tab had
 * no background and showed as thin dark text on the page, and a remote
 * selection was not drawn at all. These replacements accept exactly the
 * presence tokens instead. The colour arrives over awareness from another
 * browser, so it is checked against the list rather than passed through.
 */

interface CaretUser {
  name?: unknown;
  color?: unknown;
}

const FALLBACK = PRESENCE_COLORS[0];

export function caretColor(color: unknown): string {
  return typeof color === 'string' && (PRESENCE_COLORS as readonly string[]).includes(color)
    ? color
    : FALLBACK;
}

export function renderCaret(user: CaretUser): HTMLElement {
  const color = caretColor(user.color);
  const caret = document.createElement('span');
  caret.classList.add('collaboration-carets__caret');
  caret.style.borderColor = color;
  const label = document.createElement('div');
  label.classList.add('collaboration-carets__label');
  label.style.backgroundColor = color;
  label.append(document.createTextNode(typeof user.name === 'string' ? user.name : ''));
  caret.append(label);
  return caret;
}

export function renderCaretSelection(user: CaretUser): DecorationAttrs {
  return {
    class: 'ProseMirror-yjs-selection',
    style: `background-color: color-mix(in oklab, ${caretColor(user.color)} 45%, transparent)`,
  };
}
