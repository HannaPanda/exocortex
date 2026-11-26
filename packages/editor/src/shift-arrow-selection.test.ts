// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from './extensions';
import { shiftArrowTarget } from './shift-arrow-selection';

/**
 * Issue #251: a text selection grown with `Shift+Pfeil` stopped in front of a
 * divider, an image or a formula (Chromium, and Firefox going down past an
 * image), and a table entered from outside caught the head in a cell and threw
 * the anchor away. These tests drive the canonical extension list; the native
 * half (that every other press is the browser's) is proven in
 * `e2e/tests/editor.spec.ts`.
 */

let editor: Editor | null = null;

function createEditor(content: string): Editor {
  editor = new Editor({ extensions: buildEditorExtensions(), content });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** The position right after (or before) the first occurrence of `text`. */
function positionOf(instance: Editor, text: string, side: 'start' | 'end'): number {
  let found = -1;
  instance.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text?.includes(text) === true) {
      found = pos + node.text.indexOf(text) + (side === 'end' ? text.length : 0);
      return false;
    }
    return true;
  });
  expect(found).toBeGreaterThan(0);
  return found;
}

function select(instance: Editor, anchor: number, head: number): void {
  const { doc } = instance.state;
  instance.view.dispatch(instance.state.tr.setSelection(TextSelection.create(doc, anchor, head)));
}

/** Sends a `Shift+Pfeil` keystroke through the editor's keymap. */
function pressShift(instance: Editor, key: 'ArrowLeft' | 'ArrowRight'): boolean {
  const event = new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true });
  return (
    instance.view.someProp('handleKeyDown', (handler) => handler(instance.view, event)) ?? false
  );
}

function selectedText(instance: Editor): string {
  const { from, to } = instance.state.selection;
  return instance.state.doc.textBetween(from, to, '\n', '[block]');
}

const MATH = '<div data-type="block-math" data-latex="x^2"></div>';
const TABLE =
  '<table><tbody><tr><th><p>a</p></th><th><p>b</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>';

describe('shift arrow selection (issue #251)', () => {
  it('carries the selection over a divider to the right, keeping the anchor', () => {
    const instance = createEditor('<p>Vorher</p><hr><p>Nachher</p>');
    const anchor = positionOf(instance, 'her', 'start');
    select(instance, anchor, positionOf(instance, 'Vorher', 'end'));

    expect(pressShift(instance, 'ArrowRight')).toBe(true);

    const { selection } = instance.state;
    expect(selection.anchor).toBe(anchor);
    expect(selection.head).toBe(positionOf(instance, 'Nachher', 'start'));
    expect(selectedText(instance)).toBe('her\n[block]\n');
  });

  it('carries the selection over a divider to the left as well', () => {
    const instance = createEditor('<p>Vorher</p><hr><p>Nachher</p>');
    const anchor = positionOf(instance, 'Nach', 'end');
    select(instance, anchor, positionOf(instance, 'Nachher', 'start'));

    expect(pressShift(instance, 'ArrowLeft')).toBe(true);

    expect(instance.state.selection.anchor).toBe(anchor);
    expect(instance.state.selection.head).toBe(positionOf(instance, 'Vorher', 'end'));
  });

  it('carries the selection over a formula', () => {
    const instance = createEditor(`<p>Vorher</p>${MATH}<p>Nachher</p>`);
    const caret = positionOf(instance, 'Vorher', 'end');
    select(instance, caret, caret);

    expect(pressShift(instance, 'ArrowRight')).toBe(true);
    expect(instance.state.selection.head).toBe(positionOf(instance, 'Nachher', 'start'));
  });

  it('takes a table entered from outside as a whole', () => {
    const instance = createEditor(`<p>Vorher</p>${TABLE}<p>Nachher</p>`);
    const caret = positionOf(instance, 'Vorher', 'end');
    select(instance, caret, caret);

    expect(pressShift(instance, 'ArrowRight')).toBe(true);
    expect(instance.state.selection).toBeInstanceOf(TextSelection);
    expect(instance.state.selection.anchor).toBe(caret);
    expect(instance.state.selection.head).toBe(positionOf(instance, 'Nachher', 'start'));

    // And back: from the paragraph below, over the whole table again.
    const below = positionOf(instance, 'Nachher', 'end');
    select(instance, below, positionOf(instance, 'Nachher', 'start'));
    expect(pressShift(instance, 'ArrowLeft')).toBe(true);
    expect(instance.state.selection.anchor).toBe(below);
    expect(instance.state.selection.head).toBe(positionOf(instance, 'Vorher', 'end'));
  });

  it('leaves the edge between two paragraphs, lists and code to the browser', () => {
    const instance = createEditor(
      '<p>Eins</p><ul><li><p>Punkt</p></li></ul><pre><code>code</code></pre><p>Zwei</p>',
    );
    for (const text of ['Eins', 'Punkt', 'code']) {
      const caret = positionOf(instance, text, 'end');
      select(instance, caret, caret);
      expect(pressShift(instance, 'ArrowRight')).toBe(false);
    }
  });

  it('leaves a press inside a paragraph to the browser', () => {
    const instance = createEditor('<p>Vorher</p><hr><p>Nachher</p>');
    const caret = positionOf(instance, 'Vor', 'end');
    select(instance, caret, caret);
    expect(pressShift(instance, 'ArrowRight')).toBe(false);
  });

  it('leaves movement between table cells to the table', () => {
    const instance = createEditor(`<p>Vorher</p>${TABLE}<p>Nachher</p>`);
    const caret = positionOf(instance, 'a', 'end');
    select(instance, caret, caret);
    expect(shiftArrowTarget(instance.state, 1)).toBeNull();
  });

  it('stops where there is no text beyond the block', () => {
    const instance = createEditor(`<p>Vorher</p>${MATH}`);
    const caret = positionOf(instance, 'Vorher', 'end');
    select(instance, caret, caret);
    // A trailing paragraph may or may not follow the formula; either way the
    // answer is a text position or nothing, never a head inside the formula.
    const target = shiftArrowTarget(instance.state, 1);
    if (target !== null) expect(target.$head.parent.inlineContent).toBe(true);
  });
});
