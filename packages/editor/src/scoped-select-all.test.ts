// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { AllSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from './extensions';

/**
 * Issue #261: `Strg+A` in a code block selected the whole page, so the next
 * keystroke replaced everything. These tests drive the real keymap of the
 * canonical extension list, the way a keystroke reaches it in the browser.
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

/** Sends `Strg+A` through the editor's keymap and reports whether it was handled. */
function pressSelectAll(instance: Editor): boolean {
  const event = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true });
  return (
    instance.view.someProp('handleKeyDown', (handler) => handler(instance.view, event)) ?? false
  );
}

/** Puts the caret on the first occurrence of `text`. */
function placeCaretIn(instance: Editor, text: string): void {
  let found = -1;
  instance.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text?.includes(text) === true) {
      found = pos + node.text.indexOf(text) + 1;
      return false;
    }
    return true;
  });
  expect(found).toBeGreaterThan(0);
  instance.commands.setTextSelection(found);
}

function selectedText(instance: Editor): string {
  const { from, to } = instance.state.selection;
  return instance.state.doc.textBetween(from, to, '\n');
}

const PAGE = '<p>Davor</p><pre><code>const a = 1;\nconst b = 2;</code></pre><p>Danach</p>';

describe('scoped select all (issue #261)', () => {
  it('selects only the code block on the first press', () => {
    const instance = createEditor(PAGE);
    placeCaretIn(instance, 'const b');

    pressSelectAll(instance);

    expect(instance.state.selection).not.toBeInstanceOf(AllSelection);
    expect(selectedText(instance)).toBe('const a = 1;\nconst b = 2;');
  });

  it('selects the whole page on the second press', () => {
    const instance = createEditor(PAGE);
    placeCaretIn(instance, 'const b');

    pressSelectAll(instance);
    pressSelectAll(instance);

    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });

  it('typing after the first press replaces the code and nothing else', () => {
    const instance = createEditor(PAGE);
    placeCaretIn(instance, 'const a');

    pressSelectAll(instance);
    instance.commands.insertContent('neu');

    expect(instance.getText({ blockSeparator: '|' })).toBe('Davor|neu|Danach');
    expect(instance.state.doc.child(1).type.name).toBe('codeBlock');
  });

  it('does not let an empty code block fall through to the page', () => {
    const instance = createEditor('<p>Davor</p><pre><code></code></pre><p>Danach</p>');
    instance.commands.setTextSelection(instance.state.doc.child(0).nodeSize + 1);
    expect(instance.state.selection.$from.parent.type.name).toBe('codeBlock');

    pressSelectAll(instance);
    expect(instance.state.selection).not.toBeInstanceOf(AllSelection);

    pressSelectAll(instance);
    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });

  it('starts over after the selection was changed in between', () => {
    const instance = createEditor(PAGE);
    placeCaretIn(instance, 'const b');

    pressSelectAll(instance);
    placeCaretIn(instance, 'const a');
    pressSelectAll(instance);

    expect(selectedText(instance)).toBe('const a = 1;\nconst b = 2;');
  });

  it('selects the line, then the table cell, then the page', () => {
    const instance = createEditor(
      '<p>Davor</p><table><tr><td><p>Zelle eins</p><p>Zweiter Absatz</p></td><td><p>Zelle zwei</p></td></tr></table>',
    );
    placeCaretIn(instance, 'eins');

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Zelle eins');
    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Zelle eins\nZweiter Absatz');

    pressSelectAll(instance);
    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });

  it('selects a quote and a callout before the page', () => {
    const instance = createEditor(
      '<p>Davor</p><blockquote><p>Zitat eins</p><p>Zitat zwei</p></blockquote><p>Danach</p>',
    );
    placeCaretIn(instance, 'Zitat zwei');

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Zitat zwei');
    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Zitat eins\nZitat zwei');

    instance.commands.setContent(
      '<p>Davor</p><aside data-callout><p>Hinweis</p></aside><p>Danach</p>',
    );
    placeCaretIn(instance, 'Hinweis');
    expect(instance.state.selection.$from.node(1).type.name).toBe('callout');

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Hinweis');
    // The callout holds nothing but that line, so the next press is the page.
    pressSelectAll(instance);
    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });

  it('widens step by step from a code block inside a quote', () => {
    const instance = createEditor(
      '<p>Davor</p><blockquote><p>Einleitung</p><pre><code>x = 1</code></pre></blockquote>',
    );
    placeCaretIn(instance, 'x = 1');

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('x = 1');
    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Einleitung\nx = 1');
    pressSelectAll(instance);
    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });
});

/**
 * Issue #263: in Notion the first press selects the block the caret is in,
 * whatever block that is, and every further press widens to what is around
 * it. Before this, a paragraph, a heading or a list item gave the first press
 * to the page.
 */
describe('select all starts at the text block (issue #263)', () => {
  it('selects the paragraph, then the page', () => {
    const instance = createEditor('<p>Eins</p><p>Zwei</p>');
    placeCaretIn(instance, 'Zwei');

    pressSelectAll(instance);
    expect(instance.state.selection).not.toBeInstanceOf(AllSelection);
    expect(selectedText(instance)).toBe('Zwei');

    pressSelectAll(instance);
    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });

  it('selects a heading on its own', () => {
    const instance = createEditor('<h2>Titel hier</h2><p>Text</p>');
    placeCaretIn(instance, 'hier');

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Titel hier');
  });

  it('selects an empty paragraph first and does not stay there', () => {
    const instance = createEditor('<p>Davor</p><p></p><p>Danach</p>');
    instance.commands.setTextSelection(instance.state.doc.child(0).nodeSize + 1);
    expect(instance.state.selection.$from.parent.content.size).toBe(0);

    pressSelectAll(instance);
    expect(instance.state.selection).not.toBeInstanceOf(AllSelection);
    expect(instance.state.selection.empty).toBe(true);

    pressSelectAll(instance);
    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });

  it('goes on to the next step when the line is already selected', () => {
    const instance = createEditor('<blockquote><p>Zitat eins</p><p>Zitat zwei</p></blockquote>');
    let start = -1;
    instance.state.doc.descendants((node, pos) => {
      if (start < 0 && node.isText && node.text === 'Zitat zwei') start = pos;
      return start < 0;
    });
    instance.commands.setTextSelection({ from: start, to: start + 'Zitat zwei'.length });

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Zitat eins\nZitat zwei');
  });

  it('widens from a list item to the item with its nested items, then the page', () => {
    const instance = createEditor(
      '<p>Davor</p><ul><li><p>Oben</p><ul><li><p>Mitte</p><ul><li><p>Unten</p></li></ul></li></ul></li><li><p>Daneben</p></li></ul>',
    );
    placeCaretIn(instance, 'Mitte');

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Mitte');
    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Mitte\nUnten');
    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Oben\nMitte\nUnten');
    pressSelectAll(instance);
    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });

  it('passes over a list item that holds nothing but its line', () => {
    const instance = createEditor(
      '<ul><li><p>Oben</p><ul><li><p>Blatt</p></li></ul></li></ul><p>Danach</p>',
    );
    placeCaretIn(instance, 'Blatt');

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Blatt');
    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Oben\nBlatt');
  });

  it('does not circle in an empty list item', () => {
    const instance = createEditor('<p>Davor</p><ul><li><p></p></li></ul>');
    instance.commands.setTextSelection(instance.state.doc.child(0).nodeSize + 3);
    expect(instance.state.selection.$from.node(-1).type.name).toBe('listItem');

    pressSelectAll(instance);
    expect(instance.state.selection).not.toBeInstanceOf(AllSelection);
    pressSelectAll(instance);
    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });

  it('treats a task like a list item', () => {
    const instance = createEditor(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Aufgabe</p><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Teil</p></li></ul></li></ul>',
    );
    placeCaretIn(instance, 'Aufgabe');

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Aufgabe');
    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Aufgabe\nTeil');
  });

  it('widens from a toggle line to the whole open toggle', () => {
    const instance = createEditor(
      '<p>Davor</p><details open><summary>Kopf</summary><div data-type="details-content"><p>Innen eins</p><p>Innen zwei</p></div></details>',
    );
    placeCaretIn(instance, 'Innen zwei');

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Innen zwei');
    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Kopf\nInnen eins\nInnen zwei');
    pressSelectAll(instance);
    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });

  it('does not reach into the hidden content of a closed toggle', () => {
    const instance = createEditor(
      '<p>Davor</p><details><summary>Kopf</summary><div data-type="details-content"><p>Verborgen</p></div></details>',
    );
    placeCaretIn(instance, 'Kopf');
    expect(instance.state.selection.$from.node(1).attrs.open).toBe(false);

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Kopf');
    pressSelectAll(instance);
    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });

  it('selects the line, then its column, then the page', () => {
    const instance = createEditor(
      '<div data-columns><div data-column><p>Links eins</p><p>Links zwei</p></div><div data-column><p>Rechts</p></div></div>',
    );
    placeCaretIn(instance, 'Links eins');

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Links eins');
    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Links eins\nLinks zwei');
    pressSelectAll(instance);
    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });

  it('typing after the first press in a list item replaces its line only', () => {
    const instance = createEditor('<ul><li><p>Alt</p><ul><li><p>Kind</p></li></ul></li></ul>');
    placeCaretIn(instance, 'Alt');

    pressSelectAll(instance);
    instance.commands.insertContent('Neu');

    const { doc } = instance.state;
    expect(doc.textBetween(0, doc.content.size, '|')).toBe('Neu|Kind');
    expect(doc.child(0).type.name).toBe('bulletList');
    expect(doc.child(0).child(0).childCount).toBe(2);
  });
});
