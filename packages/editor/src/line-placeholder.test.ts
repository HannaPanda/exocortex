// @vitest-environment jsdom
import { Editor, Extension } from '@tiptap/core';
import { history, undo } from '@tiptap/pm/history';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { ySyncPlugin } from 'y-prosemirror';
import * as Y from 'yjs';

import { buildEditorExtensions } from './extensions';
import { LINE_PLACEHOLDER_ATTRIBUTE, LinePlaceholder } from './line-placeholder';
import { YJS_DOCUMENT_FIELD } from './yjs';

/**
 * Issue #227: the hint stands in the empty line being written in and nowhere
 * else, and it goes with whatever fills, leaves or blurs that line. What only a
 * browser proves (the real keys, the real focus, a second tab) is in
 * `e2e/tests/editor.spec.ts`.
 */

const HINT = 'Schreib was';

const editors: Editor[] = [];

/**
 * The page editor's undo comes with collaboration (Yjs); the plain history
 * plugin stands in for it here. Each step below is its own transaction.
 */
const History = Extension.create({
  name: 'testHistory',
  addProseMirrorPlugins: () => [history({ newGroupDelay: 0 })],
});

function undoOnce(editor: Editor): void {
  expect(undo(editor.state, editor.view.dispatch)).toBe(true);
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function createEditor(content: string, options: { editable?: boolean } = {}): Editor {
  const editor = new Editor({
    extensions: buildEditorExtensions({
      additionalExtensions: [History, LinePlaceholder.configure({ placeholder: HINT })],
    }),
    content,
    editable: options.editable ?? true,
  });
  editors.push(editor);
  return editor;
}

/** The focus the browser would give, through Tiptap's own focus handler. */
function focus(editor: Editor): void {
  editor.view.dom.dispatchEvent(new FocusEvent('focus'));
}

function blur(editor: Editor): void {
  editor.view.dom.dispatchEvent(new FocusEvent('blur'));
}

/** Puts the caret at the end of the `index`-th text block of the page. */
function caretIn(editor: Editor, index: number): void {
  let seen = -1;
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (!node.isTextblock) return true;
    seen += 1;
    if (seen === index) found = pos + 1 + node.content.size;
    return false;
  });
  expect(found).toBeGreaterThan(0);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, found)));
}

/** The lines drawing the hint, by their text (always empty when right). */
function hinted(editor: Editor): string[] {
  return [...editor.view.dom.querySelectorAll(`[${LINE_PLACEHOLDER_ATTRIBUTE}]`)].map(
    (element) => `${element.tagName.toLowerCase()}:${element.textContent ?? ''}`,
  );
}

describe('LinePlaceholder', () => {
  it('follows the caret and leaves nothing behind in the lines it passed', () => {
    const editor = createEditor('<p>a</p><p></p><p>b</p><p></p><p>c</p>');
    focus(editor);
    caretIn(editor, 1);
    expect(hinted(editor)).toEqual(['p:']);
    caretIn(editor, 3);
    expect(hinted(editor)).toEqual(['p:']);
    // Tiptap's own placeholder still showed the first empty line here.
    caretIn(editor, 4);
    expect(hinted(editor)).toEqual([]);
  });

  it('stands in an empty list point and moves with the caret', () => {
    const editor = createEditor(
      '<ul><li><p>a</p></li><li><p></p></li></ul><p>zwischen</p><ul><li><p></p></li></ul>',
    );
    focus(editor);
    caretIn(editor, 1);
    expect(hinted(editor)).toEqual(['p:']);
    caretIn(editor, 3);
    expect(hinted(editor)).toEqual(['p:']);
    caretIn(editor, 2);
    expect(hinted(editor)).toEqual([]);
  });

  it('goes with typing, a hard break, a paste and the undo of each', () => {
    const editor = createEditor('<p>a</p><p></p>');
    focus(editor);
    caretIn(editor, 1);
    editor.commands.insertContent('x');
    expect(hinted(editor)).toEqual([]);
    undoOnce(editor);
    expect(editor.getText()).toBe('a\n\n');
    expect(hinted(editor)).toEqual(['p:']);

    editor.commands.setHardBreak();
    expect(hinted(editor)).toEqual([]);
    undoOnce(editor);
    expect(hinted(editor)).toEqual(['p:']);

    editor.commands.insertContent('<p>eins</p><p>zwei</p>');
    expect(hinted(editor)).toEqual([]);
    undoOnce(editor);
    expect(hinted(editor)).toEqual(['p:']);
  });

  it('shows a new line made with Enter, and only that one', () => {
    const editor = createEditor('<ul><li><p>a</p></li></ul>');
    focus(editor);
    caretIn(editor, 0);
    editor.commands.splitListItem('listItem');
    expect(hinted(editor)).toEqual(['p:']);
    editor.commands.insertContent('b');
    editor.commands.splitListItem('listItem');
    expect(hinted(editor)).toEqual(['p:']);
    expect(editor.view.dom.querySelectorAll('li')).toHaveLength(3);
  });

  it('is gone while the editor has no focus, except on a page with nothing on it', () => {
    const editor = createEditor('<p>a</p><p></p>');
    caretIn(editor, 1);
    expect(hinted(editor)).toEqual([]);
    focus(editor);
    expect(hinted(editor)).toEqual(['p:']);
    blur(editor);
    expect(hinted(editor)).toEqual([]);

    const empty = createEditor('');
    expect(empty.state.doc.childCount).toBe(1);
    expect(hinted(empty)).toEqual(['p:']);
  });

  it('stays out of a selection, a picture and a heading', () => {
    const editor = createEditor(
      '<p>a</p><p></p><img data-block-id="bild" src="https://example.org/bild.png"><h2></h2>',
    );
    focus(editor);
    const { doc } = editor.state;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(doc, 1, 5)));
    expect(hinted(editor)).toEqual([]);
    let imagePos = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === 'image') imagePos = pos;
      return true;
    });
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(doc, imagePos)));
    expect(hinted(editor)).toEqual([]);
    caretIn(editor, 2);
    expect(hinted(editor)).toEqual([]);
  });

  it('is never drawn on a page that cannot be written', () => {
    const editor = createEditor('', { editable: false });
    focus(editor);
    expect(hinted(editor)).toEqual([]);
  });

  it('never reaches the text, the Markdown or the Yjs state', async () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment(YJS_DOCUMENT_FIELD);
    const Sync = Extension.create({
      name: 'testSync',
      addProseMirrorPlugins: () => [ySyncPlugin(fragment)],
    });
    const editor = new Editor({
      extensions: buildEditorExtensions({
        additionalExtensions: [Sync, LinePlaceholder.configure({ placeholder: HINT })],
      }),
    });
    editors.push(editor);
    await new Promise((resolve) => setTimeout(resolve, 10));
    editor.commands.setContent('<p>a</p><p></p>');
    focus(editor);
    caretIn(editor, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hinted(editor)).toEqual(['p:']);
    expect(editor.getText()).not.toContain(HINT);
    expect(JSON.stringify(editor.getJSON())).not.toContain(HINT);
    expect(fragment.toString()).not.toContain(HINT);
    expect(fragment.toString()).not.toContain('placeholder');
  });
});
