// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from './extensions';
import { movableBlockAt, moveBlockTransaction } from './move-block';

/**
 * Issue #243: the keyboard alternative to dragging a block. The shortcut runs
 * through the editor's own keymap here, as it does in the browser.
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

/** Puts the caret inside the text block whose text is `text`. */
function caretIn(instance: Editor, text: string, offset = 1): number {
  let found = -1;
  instance.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isTextblock && node.textContent === text) {
      found = pos + 1 + offset;
      return false;
    }
    return true;
  });
  expect(found).toBeGreaterThan(0);
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.create(instance.state.doc, found)),
  );
  return found;
}

/** Sends `Strg+Umschalt+Pfeil` through the keymap (jsdom is not a Mac). */
function press(instance: Editor, key: 'ArrowUp' | 'ArrowDown'): boolean {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true });
  return (
    instance.view.someProp('handleKeyDown', (handler) => handler(instance.view, event)) ?? false
  );
}

function texts(instance: Editor): string[] {
  const out: string[] = [];
  instance.state.doc.descendants((node) => {
    if (node.isTextblock) out.push(node.textContent);
    return true;
  });
  return out;
}

describe('moving a block with the keyboard', () => {
  it('moves a list item with its sub-items and keeps the caret in it', () => {
    const instance = createEditor(
      '<ol><li><p>Eins</p></li><li><p>Zwei</p><ul><li><p>Zwei a</p></li></ul></li><li><p>Drei</p></li></ol>',
    );
    caretIn(instance, 'Zwei', 2);
    expect(press(instance, 'ArrowUp')).toBe(true);
    expect(texts(instance)).toEqual(['Zwei', 'Zwei a', 'Eins', 'Drei']);
    expect(instance.state.selection.$from.parent.textContent).toBe('Zwei');
    expect(instance.state.selection.$from.parentOffset).toBe(2);

    expect(press(instance, 'ArrowDown')).toBe(true);
    expect(press(instance, 'ArrowDown')).toBe(true);
    expect(texts(instance)).toEqual(['Eins', 'Drei', 'Zwei', 'Zwei a']);
  });

  it('stops at the edge of its list and still takes the key', () => {
    const instance = createEditor('<p>Oben</p><ul><li><p>A</p></li><li><p>B</p></li></ul>');
    caretIn(instance, 'A', 0);
    const before = instance.state.doc;
    expect(press(instance, 'ArrowUp')).toBe(true);
    expect(instance.state.doc.eq(before)).toBe(true);
  });

  it('moves a top-level paragraph past a whole list', () => {
    const instance = createEditor('<p>Oben</p><ul><li><p>A</p></li><li><p>B</p></li></ul>');
    caretIn(instance, 'Oben');
    press(instance, 'ArrowDown');
    expect(texts(instance)).toEqual(['A', 'B', 'Oben']);
  });

  it('moves a whole table, never a cell paragraph', () => {
    const instance = createEditor(
      '<p>Vor</p><table><tbody><tr><td><p>Zelle</p></td></tr></tbody></table><p>Nach</p>',
    );
    caretIn(instance, 'Zelle');
    expect(movableBlockAt(instance.state)?.node.type.name).toBe('table');
    press(instance, 'ArrowUp');
    expect(texts(instance)).toEqual(['Zelle', 'Vor', 'Nach']);
  });

  it('moves a selected image and keeps it selected', () => {
    const instance = createEditor('<p>Eins</p><img src="/a.png"><p>Zwei</p>');
    let imagePos = -1;
    instance.state.doc.forEach((node, offset) => {
      if (node.type.name === 'image') imagePos = offset;
    });
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, imagePos)),
    );
    const tr = moveBlockTransaction(instance.state, imagePos, -1);
    expect(tr).not.toBeNull();
    if (tr !== null) instance.view.dispatch(tr);
    expect(instance.state.doc.child(0).type.name).toBe('image');
    expect(instance.state.selection).toBeInstanceOf(NodeSelection);
  });
});
