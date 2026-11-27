// @vitest-environment jsdom
import { Editor, Extension } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import { ySyncPlugin } from 'y-prosemirror';
import * as Y from 'yjs';

import { buildEditorExtensions } from './extensions';
import {
  arrowDownLeavesPage,
  needsTrailingParagraph,
  TRAILING_LINE_ATTRIBUTE,
} from './trailing-paragraph';
import { YJS_DOCUMENT_FIELD } from './yjs';

/**
 * Issues #257 and #303: below a last block that is not an empty paragraph
 * there is a line to write in. It is drawn, not stored, and the paragraph is made on use: a click
 * below the block or arrow down from the bottom of the page. What only a
 * browser proves (the space is there, the real click and key) is in
 * `e2e/tests/editor.spec.ts`.
 */

const editors: Editor[] = [];

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function createEditor(content: string, editable = true): Editor {
  const editor = new Editor({ extensions: buildEditorExtensions(), content, editable });
  editors.push(editor);
  return editor;
}

const IMAGE = '<img data-block-id="bild" src="https://example.org/bild.png">';

function press(editor: Editor, key: string): boolean {
  const event = new KeyboardEvent('keydown', { key });
  return editor.view.someProp('handleKeyDown', (handler) => handler(editor.view, event)) ?? false;
}

function lastType(editor: Editor): string | undefined {
  return editor.state.doc.lastChild?.type.name;
}

function selectLastNode(editor: Editor): void {
  const { doc } = editor.state;
  const last = doc.lastChild;
  if (last === null) throw new Error('empty document');
  editor.view.dispatch(
    editor.state.tr.setSelection(NodeSelection.create(doc, doc.content.size - last.nodeSize)),
  );
}

/** Puts the caret at the end of the text block whose text is `text`. */
function caretAfter(editor: Editor, text: string): void {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isTextblock && node.textContent === text) {
      found = pos + 1 + node.content.size;
      return false;
    }
    return true;
  });
  expect(found).toBeGreaterThan(0);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, found)));
}

describe('needsTrailingParagraph', () => {
  it('asks for the line after anything that is not a paragraph', () => {
    expect(needsTrailingParagraph(createEditor(`<p>Text</p>${IMAGE}`).state.doc)).toBe(true);
    expect(needsTrailingParagraph(createEditor('<pre><code>x</code></pre>').state.doc)).toBe(true);
    expect(
      needsTrailingParagraph(createEditor('<table><tr><td>a</td></tr></table>').state.doc),
    ).toBe(true);
    expect(needsTrailingParagraph(createEditor('<ul><li>Punkt</li></ul>').state.doc)).toBe(true);
    expect(needsTrailingParagraph(createEditor('<h2>Quellen</h2>').state.doc)).toBe(true);
  });

  it('asks for it after a paragraph with something in it, a link included (#303)', () => {
    expect(needsTrailingParagraph(createEditor(`${IMAGE}<p>Text</p>`).state.doc)).toBe(true);
    expect(
      needsTrailingParagraph(
        createEditor('<h2>Quellen</h2><p><a href="https://example.org">https://example.org</a></p>')
          .state.doc,
      ),
    ).toBe(true);
  });

  it('leaves a page alone that already ends in an empty paragraph', () => {
    expect(needsTrailingParagraph(createEditor(`${IMAGE}<p></p>`).state.doc)).toBe(false);
    expect(needsTrailingParagraph(createEditor('<p>Text</p><p></p>').state.doc)).toBe(false);
  });
});

describe('the line is drawn, not stored', () => {
  it('marks the editor while the page needs the line, and only then', () => {
    const editor = createEditor(`<p>Text</p>${IMAGE}`);
    expect(editor.view.dom.hasAttribute(TRAILING_LINE_ATTRIBUTE)).toBe(true);
    selectLastNode(editor);
    press(editor, 'ArrowDown');
    expect(editor.view.dom.hasAttribute(TRAILING_LINE_ATTRIBUTE)).toBe(false);
  });

  it('writes nothing into the Yjs state when the page opens', async () => {
    // The stored state: a page that ends in a picture.
    const source = createEditor(`<p data-block-id="text">Text</p>${IMAGE}`);
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment(YJS_DOCUMENT_FIELD);
    const Sync = Extension.create({
      name: 'testSync',
      addProseMirrorPlugins: () => [ySyncPlugin(fragment)],
    });
    // Fill the fragment through a first editor, the way a stored page arrives.
    const writer = new Editor({
      extensions: buildEditorExtensions({ additionalExtensions: [Sync] }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    writer.commands.setContent(source.getJSON());
    await new Promise((resolve) => setTimeout(resolve, 10));
    writer.destroy();
    expect(fragment.length).toBe(2);

    let updates = 0;
    ydoc.on('update', () => {
      updates += 1;
    });
    const reader = new Editor({
      extensions: buildEditorExtensions({ additionalExtensions: [Sync] }),
    });
    editors.push(reader);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(lastType(reader)).toBe('image');
    expect(reader.view.dom.hasAttribute(TRAILING_LINE_ATTRIBUTE)).toBe(true);
    expect(updates).toBe(0);
    expect(fragment.length).toBe(2);

    // Using the line is one write, and it makes one paragraph.
    selectLastNode(reader);
    expect(press(reader, 'ArrowDown')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fragment.length).toBe(3);
    expect(updates).toBe(1);
  });
});

describe('arrow down', () => {
  it('makes the line below a selected picture and puts the caret into it', () => {
    const editor = createEditor(`<p>Text</p>${IMAGE}`);
    selectLastNode(editor);
    expect(press(editor, 'ArrowDown')).toBe(true);
    expect(lastType(editor)).toBe('paragraph');
    expect(editor.state.doc.childCount).toBe(3);
    const { selection } = editor.state;
    expect(selection).toBeInstanceOf(TextSelection);
    expect(selection.$head.parent).toBe(editor.state.doc.lastChild);

    // Once the page ends in a paragraph, a second press makes nothing.
    expect(press(editor, 'ArrowDown')).toBe(false);
    expect(editor.state.doc.childCount).toBe(3);
  });

  it('leaves a picture with something after it to the browser', () => {
    const editor = createEditor(`${IMAGE}<pre><code>x</code></pre>`);
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    expect(press(editor, 'ArrowDown')).toBe(false);
    expect(editor.state.doc.childCount).toBe(2);
  });

  it('leaves a read-only page alone', () => {
    const editor = createEditor(`<p>Text</p>${IMAGE}`, false);
    selectLastNode(editor);
    expect(press(editor, 'ArrowDown')).toBe(false);
    expect(lastType(editor)).toBe('image');
  });

  it('leaves the bottom line of the text a page ends in', () => {
    const editor = createEditor('<pre><code>eins</code></pre><pre><code>zwei</code></pre>');
    caretAfter(editor, 'zwei');
    expect(arrowDownLeavesPage(editor.state, true)).toBe(true);
    // Not from a line above the last one inside the block.
    expect(arrowDownLeavesPage(editor.state, false)).toBe(false);
    // Not from a block that has another one below it.
    caretAfter(editor, 'eins');
    expect(arrowDownLeavesPage(editor.state, true)).toBe(false);
  });

  it('leaves the last point of a list, not a point above it', () => {
    const editor = createEditor('<ul><li><p>eins</p></li><li><p>zwei</p></li></ul>');
    caretAfter(editor, 'zwei');
    expect(arrowDownLeavesPage(editor.state, true)).toBe(true);
    caretAfter(editor, 'eins');
    expect(arrowDownLeavesPage(editor.state, true)).toBe(false);
  });

  it('leaves a table from every cell of its last row, and only there', () => {
    const editor = createEditor(
      '<table><tr><td><p>a</p></td><td><p>b</p></td></tr><tr><td><p>c</p></td><td><p>d</p></td></tr></table>',
    );
    caretAfter(editor, 'c');
    expect(arrowDownLeavesPage(editor.state, true)).toBe(true);
    caretAfter(editor, 'd');
    expect(arrowDownLeavesPage(editor.state, true)).toBe(true);
    caretAfter(editor, 'a');
    expect(arrowDownLeavesPage(editor.state, true)).toBe(false);
  });

  it('never acts on a page that already ends in an empty paragraph', () => {
    const editor = createEditor('<pre><code>x</code></pre><p></p>');
    const end = editor.state.doc.content.size - 1;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)));
    expect(arrowDownLeavesPage(editor.state, true)).toBe(false);
  });

  it('leaves the paragraph a page ends in from its end, not from inside it (#303)', () => {
    const editor = createEditor(
      '<h2>Quellen</h2><p><a href="https://example.org">https://example.org</a></p>',
    );
    caretAfter(editor, 'https://example.org');
    expect(arrowDownLeavesPage(editor.state, true)).toBe(true);
    // Inside the last line the browser first moves the caret to its end.
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 12)));
    expect(arrowDownLeavesPage(editor.state, true)).toBe(false);
    // A paragraph above another block is not the end of the page.
    const above = createEditor('<p>oben</p><h2>Quellen</h2>');
    caretAfter(above, 'oben');
    expect(arrowDownLeavesPage(above.state, true)).toBe(false);
  });
});

describe('a click below the last block', () => {
  /**
   * Hands the press to the editor's handlers the way the view does. Not
   * dispatched on the element: ProseMirror's own handler, which runs whenever
   * ours declines, asks `elementFromPoint`, and jsdom has none.
   */
  function mousedown(editor: Editor, target: Element, clientY: number): MouseEvent {
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientY,
    });
    Object.defineProperty(event, 'target', { value: target });
    editor.view.someProp('handleDOMEvents', (handlers) => handlers.mousedown?.(editor.view, event));
    return event;
  }

  it('makes the line below a paragraph with a link, not a caret behind the link (#303)', () => {
    const editor = createEditor(
      '<h2>Quellen</h2><p><a href="https://example.org">https://example.org</a></p>',
    );
    const event = mousedown(editor, editor.view.dom, 40);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.lastChild?.content.size).toBe(0);
    expect(editor.state.selection.$head.parent).toBe(editor.state.doc.lastChild);
    // The new line carries no link mark into what is typed next.
    expect(editor.state.storedMarks ?? []).toHaveLength(0);
  });

  it('makes the line and puts the caret into it', () => {
    const editor = createEditor(`<p>Text</p>${IMAGE}`);
    // jsdom lays nothing out: every block ends at 0, so any y below is below.
    const event = mousedown(editor, editor.view.dom, 40);
    expect(event.defaultPrevented).toBe(true);
    expect(lastType(editor)).toBe('paragraph');
    expect(editor.state.selection.$head.parent).toBe(editor.state.doc.lastChild);

    // The page ends in a paragraph now: the next click is the browser's.
    const again = mousedown(editor, editor.view.dom, 40);
    expect(again.defaultPrevented).toBe(false);
    expect(editor.state.doc.childCount).toBe(3);
  });

  it('leaves a click on a block to the block', () => {
    const editor = createEditor(`<p>Text</p>${IMAGE}`);
    const image = editor.view.dom.querySelector('img');
    if (image === null) throw new Error('no image');
    mousedown(editor, image, 40);
    expect(lastType(editor)).toBe('image');
  });

  it('does nothing on a read-only page', () => {
    const editor = createEditor(`<p>Text</p>${IMAGE}`, false);
    mousedown(editor, editor.view.dom, 40);
    expect(lastType(editor)).toBe('image');
  });
});
