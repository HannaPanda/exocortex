// @vitest-environment jsdom
import { Editor, Extension } from '@tiptap/core';
import { history, undo } from '@tiptap/pm/history';
import { type Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from './extensions';
import { movableBlockAt, moveBlockTransaction } from './move-block';

/**
 * Issue #243: the keyboard alternative to dragging a block. The shortcut runs
 * through the editor's own keymap here, as it does in the browser.
 */

let editor: Editor | null = null;

/** The page's undo comes with Yjs; the plain history stands in for it here. */
const History = Extension.create({
  name: 'testHistory',
  addProseMirrorPlugins: () => [history()],
});

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

/** The top-level blocks: a text block by its text, a container by its texts. */
function shape(instance: Editor): string[] {
  const out: string[] = [];
  instance.state.doc.forEach((node) => {
    if (node.isTextblock) {
      out.push(`p:${node.textContent}`);
      return;
    }
    const inner: string[] = [];
    node.forEach((child) => {
      inner.push(child.isTextblock ? child.textContent : (child.firstChild?.textContent ?? ''));
    });
    out.push(`${node.type.name}[${inner.join(',')}]`);
  });
  return out;
}

/** List items as an outline, indented by depth. */
function outline(instance: Editor): string[] {
  const lines: string[] = [];
  const walk = (node: PmNode, level: number): void => {
    node.forEach((child) => {
      if (child.isTextblock) {
        lines.push(`${'  '.repeat(Math.max(0, level - 1))}${child.textContent}`);
        return;
      }
      const list = ['orderedList', 'bulletList', 'taskList'].includes(child.type.name);
      walk(child, level + (list ? 1 : 0));
    });
  };
  walk(instance.state.doc, 0);
  return lines;
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

  it('stops at the edge of the page and still takes the key', () => {
    const instance = createEditor('<p>Oben</p><ul><li><p>A</p></li><li><p>B</p></li></ul>');
    caretIn(instance, 'Oben', 0);
    const before = instance.state.doc;
    expect(press(instance, 'ArrowUp')).toBe(true);
    expect(instance.state.doc.eq(before)).toBe(true);
  });

  it('takes the first item out of its list as a paragraph, and the next press past the block above', () => {
    const instance = createEditor(
      '<p>Oben</p><ul><li><p>A</p><ul><li><p>A1</p></li></ul></li><li><p>B</p></li></ul>',
    );
    caretIn(instance, 'A', 1);
    expect(press(instance, 'ArrowUp')).toBe(true);
    // A is a paragraph now, its sub-item stays a list right underneath it.
    expect(shape(instance)).toEqual(['p:Oben', 'p:A', 'bulletList[A1]', 'bulletList[B]']);
    expect(instance.state.selection.$from.parent.textContent).toBe('A');
    expect(instance.state.selection.$from.parentOffset).toBe(1);
    press(instance, 'ArrowUp');
    expect(shape(instance)).toEqual(['p:A', 'p:Oben', 'bulletList[A1]', 'bulletList[B]']);
  });

  it('takes the last item of a numbered list out below it', () => {
    const instance = createEditor('<ol><li><p>Eins</p></li><li><p>Zwei</p></li></ol><p>Unten</p>');
    caretIn(instance, 'Zwei');
    press(instance, 'ArrowDown');
    expect(shape(instance)).toEqual(['orderedList[Eins]', 'p:Zwei', 'p:Unten']);
  });

  it('turns a task out of its list into a paragraph', () => {
    const instance = createEditor(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Erledigt</p></li>' +
        '<li data-type="taskItem" data-checked="false"><p>Offen</p></li></ul>',
    );
    caretIn(instance, 'Erledigt');
    press(instance, 'ArrowUp');
    expect(shape(instance)).toEqual(['p:Erledigt', 'taskList[Offen]']);
  });

  it('moves a list of one item as a whole, so a lone bullet stays a bullet', () => {
    const instance = createEditor('<p>Oben</p><ul><li><p>A</p></li></ul>');
    caretIn(instance, 'A');
    press(instance, 'ArrowUp');
    expect(shape(instance)).toEqual(['bulletList[A]', 'p:Oben']);
  });

  it('moves a sub-item out of its sub-list, before or after the item holding it', () => {
    const html =
      '<ul><li><p>A</p><ul><li><p>A1</p></li><li><p>A2</p></li></ul></li><li><p>B</p></li></ul>';
    let instance = createEditor(html);
    caretIn(instance, 'A1');
    press(instance, 'ArrowUp');
    expect(outline(instance)).toEqual(['A1', 'A', '  A2', 'B']);
    instance.destroy();

    instance = createEditor(html);
    editor = instance;
    caretIn(instance, 'A2');
    press(instance, 'ArrowDown');
    expect(outline(instance)).toEqual(['A', '  A1', 'A2', 'B']);
    // The caret came along, so the next press moves it past B.
    press(instance, 'ArrowDown');
    expect(outline(instance)).toEqual(['A', '  A1', 'B', 'A2']);
  });

  it('leaves an emptied sub-list behind as nothing', () => {
    const instance = createEditor(
      '<ul><li><p>A</p><ul><li><p>A1</p></li></ul></li><li><p>B</p></li></ul>',
    );
    caretIn(instance, 'A1');
    press(instance, 'ArrowUp');
    expect(outline(instance)).toEqual(['A1', 'A', 'B']);
    expect(instance.getHTML()).not.toContain('<ul></ul>');
  });

  it('moves a block out of a quote and a callout, and the container stays', () => {
    const instance = createEditor(
      '<p>Oben</p><blockquote><p>Q1</p><p>Q2</p></blockquote><p>Unten</p>',
    );
    caretIn(instance, 'Q1');
    press(instance, 'ArrowUp');
    expect(shape(instance)).toEqual(['p:Oben', 'p:Q1', 'blockquote[Q2]', 'p:Unten']);
    caretIn(instance, 'Q2');
    // Alone in the quote: the quote is what moves.
    press(instance, 'ArrowDown');
    expect(shape(instance)).toEqual(['p:Oben', 'p:Q1', 'p:Unten', 'blockquote[Q2]']);

    const callout = createEditor('<aside data-callout><p>C1</p><p>C2</p></aside><p>Unten</p>');
    editor = callout;
    instance.destroy();
    caretIn(callout, 'C2');
    press(callout, 'ArrowDown');
    expect(shape(callout)).toEqual(['callout[C1]', 'p:C2', 'p:Unten']);
  });

  it('passes a list, a quote or a callout from outside as a whole, never entering it', () => {
    const instance = createEditor(
      '<p>Oben</p><blockquote><p>Q1</p><p>Q2</p></blockquote><ul><li><p>A</p></li><li><p>B</p></li></ul>',
    );
    caretIn(instance, 'Oben');
    press(instance, 'ArrowDown');
    expect(shape(instance)).toEqual(['blockquote[Q1,Q2]', 'p:Oben', 'bulletList[A,B]']);
    press(instance, 'ArrowDown');
    expect(shape(instance)).toEqual(['blockquote[Q1,Q2]', 'bulletList[A,B]', 'p:Oben']);
  });

  it("never moves a block inside a list item above the item's own text", () => {
    const instance = createEditor('<ul><li><p>A</p><p>Weiter</p></li></ul>');
    caretIn(instance, 'Weiter');
    const before = instance.state.doc;
    press(instance, 'ArrowUp');
    expect(instance.state.doc.eq(before)).toBe(true);
  });

  it('takes a move out of a container back in one undo step', () => {
    const instance = new Editor({
      extensions: [...buildEditorExtensions(), History],
      content: '<p>Oben</p><ol><li><p>Eins</p></li><li><p>Zwei</p></li><li><p>Drei</p></li></ol>',
    });
    editor = instance;
    caretIn(instance, 'Eins');
    press(instance, 'ArrowUp');
    expect(shape(instance)).toEqual(['p:Oben', 'p:Eins', 'orderedList[Zwei,Drei]']);
    undo(instance.state, instance.view.dispatch);
    expect(shape(instance)).toEqual(['p:Oben', 'orderedList[Eins,Zwei,Drei]']);
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
