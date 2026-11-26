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

  it('selects a table cell first, then the page', () => {
    const instance = createEditor(
      '<p>Davor</p><table><tr><td><p>Zelle eins</p><p>Zweiter Absatz</p></td><td><p>Zelle zwei</p></td></tr></table>',
    );
    placeCaretIn(instance, 'eins');

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
    expect(selectedText(instance)).toBe('Zitat eins\nZitat zwei');

    instance.commands.setContent(
      '<p>Davor</p><aside data-callout><p>Hinweis</p></aside><p>Danach</p>',
    );
    placeCaretIn(instance, 'Hinweis');
    expect(instance.state.selection.$from.node(1).type.name).toBe('callout');

    pressSelectAll(instance);
    expect(selectedText(instance)).toBe('Hinweis');
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

  it('leaves an ordinary paragraph to the usual select all', () => {
    const instance = createEditor('<p>Eins</p><p>Zwei</p>');
    placeCaretIn(instance, 'Zwei');

    pressSelectAll(instance);

    expect(instance.state.selection).toBeInstanceOf(AllSelection);
  });
});
