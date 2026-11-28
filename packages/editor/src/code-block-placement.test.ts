// @vitest-environment jsdom
import { Editor, Extension } from '@tiptap/core';
import { history, undo } from '@tiptap/pm/history';
import { type Node as PmNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { coreStructureBlocks } from './block-catalog';
import { turnBlockInto } from './block-target';
import { buildEditorExtensions } from './extensions';

/**
 * Issue #318: a code block made under a list item's text took that text with
 * it. These run the real commands (the catalog entry the slash menu runs, the
 * fence input rule, the keyboard), so they also cover the wiring in
 * `code-block.ts`; what only a browser proves (the real keys, the Yjs undo) is
 * in `e2e/tests/editor.spec.ts`.
 */

let editor: Editor | null = null;

/** The page editor's undo comes with Yjs; the plain history stands in here. */
const History = Extension.create({
  name: 'testHistory',
  addProseMirrorPlugins: () => [history()],
});

function createEditor(content: string): Editor {
  editor = new Editor({ extensions: [...buildEditorExtensions(), History], content });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const codeEntry = coreStructureBlocks.find((entry) => entry.id === 'code-block');
if (codeEntry === undefined) throw new Error('no code block entry');

/** The document as nested `type[...]`, text blocks as `type:text`, a line break as `⏎`. */
function shape(node: PmNode): string {
  if (node.isTextblock) {
    let text = '';
    node.forEach((child) => {
      text += child.isText ? (child.text ?? '') : '⏎';
    });
    return `${node.type.name}:${text}`;
  }
  const children: string[] = [];
  node.forEach((child) => children.push(shape(child)));
  return node.type.name === 'doc' ? children.join(' ') : `${node.type.name}[${children.join(',')}]`;
}

/** Puts the caret right after the first occurrence of `text`. */
function caretAfter(instance: Editor, text: string): void {
  let at = -1;
  instance.state.doc.descendants((node, pos) => {
    if (at >= 0 || !node.isText) return at < 0;
    const index = (node.text ?? '').indexOf(text);
    if (index >= 0) at = pos + index + text.length;
    return false;
  });
  if (at < 0) throw new Error(`no text ${text}`);
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.create(instance.state.doc, at)),
  );
}

/** Selects the first occurrence of `text`. */
function select(instance: Editor, text: string): void {
  caretAfter(instance, text);
  const to = instance.state.selection.from;
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.create(instance.state.doc, to - text.length, to)),
  );
}

/** Types `text` the way the keyboard does, input rules included. */
function type(instance: Editor, text: string): void {
  for (const character of text) {
    const { from, to } = instance.state.selection;
    const handled = instance.view.someProp('handleTextInput', (handler) =>
      handler(instance.view, from, to, character, () =>
        instance.state.tr.insertText(character, from, to),
      ),
    );
    if (handled !== true) instance.view.dispatch(instance.state.tr.insertText(character, from, to));
  }
}

/** The slash menu's "Codeblock": the catalog entry, as the menu runs it. */
function slashCode(instance: Editor): void {
  expect(codeEntry?.run(instance)).toBe(true);
}

/** Where the caret stands, as the type of its text block and that block's text. */
function caretBlock(instance: Editor): string {
  const { $from } = instance.state.selection;
  return `${$from.parent.type.name}:${$from.parent.textContent}`;
}

function undoOnce(instance: Editor): void {
  expect(undo(instance.state, instance.view.dispatch)).toBe(true);
}

const LISTS = {
  bullet: {
    html: '<ul><li><p>Alpha</p><ul><li><p>Beta</p></li></ul></li><li><p>Gamma</p></li></ul>',
    list: 'bulletList',
    item: 'listItem',
  },
  numbered: {
    html: '<ol><li><p>Alpha</p><ol><li><p>Beta</p></li></ol></li><li><p>Gamma</p></li></ol>',
    list: 'orderedList',
    item: 'listItem',
  },
  task: {
    html:
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Alpha</p>' +
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Beta</p></li></ul></li>' +
      '<li data-type="taskItem" data-checked="false"><p>Gamma</p></li></ul>',
    list: 'taskList',
    item: 'taskItem',
  },
} as const;

describe.each(Object.entries(LISTS))('a code block in a %s list', (_name, { html, list, item }) => {
  const original = (): string =>
    `${list}[${item}[paragraph:Alpha,${list}[${item}[paragraph:Beta]]],${item}[paragraph:Gamma]]`;

  it('after Umschalt+Enter under a sub-item: empty, inside the item, the text stays', () => {
    const instance = createEditor(html);
    caretAfter(instance, 'Beta');
    instance.commands.setHardBreak();
    slashCode(instance);
    expect(shape(instance.state.doc)).toBe(
      `${list}[${item}[paragraph:Alpha,${list}[${item}[paragraph:Beta,codeBlock:]]],${item}[paragraph:Gamma]]`,
    );
    expect(caretBlock(instance)).toBe('codeBlock:');
    // One step takes the block back (here together with the line break typed
    // the same moment, as the history groups them), and Beta is untouched.
    undoOnce(instance);
    expect(shape(instance.state.doc)).not.toContain('codeBlock');
    expect(shape(instance.state.doc)).toContain('paragraph:Beta');
  });

  it('after Umschalt+Enter under an item with sub-items: directly under its text', () => {
    const instance = createEditor(html);
    caretAfter(instance, 'Alpha');
    instance.commands.setHardBreak();
    slashCode(instance);
    expect(shape(instance.state.doc)).toBe(
      `${list}[${item}[paragraph:Alpha,codeBlock:,${list}[${item}[paragraph:Beta]]],${item}[paragraph:Gamma]]`,
    );
  });

  it('typed as a fence after Umschalt+Enter, with its language', () => {
    const instance = createEditor(html);
    caretAfter(instance, 'Gamma');
    instance.commands.setHardBreak();
    type(instance, '```ts ');
    expect(shape(instance.state.doc)).toBe(
      `${list}[${item}[paragraph:Alpha,${list}[${item}[paragraph:Beta]]],${item}[paragraph:Gamma,codeBlock:]]`,
    );
    expect(instance.state.selection.$from.parent.attrs.language).toBe('ts');
  });

  it('with the caret on the item text: a new, empty block under it, the text untouched', () => {
    const instance = createEditor(html);
    caretAfter(instance, 'Al');
    slashCode(instance);
    expect(shape(instance.state.doc)).toBe(
      `${list}[${item}[paragraph:Alpha,codeBlock:,${list}[${item}[paragraph:Beta]]],${item}[paragraph:Gamma]]`,
    );
    expect(caretBlock(instance)).toBe('codeBlock:');
    undoOnce(instance);
    expect(shape(instance.state.doc)).toBe(original());
  });

  it('from an empty sub-item: replaces it and stays at its indentation', () => {
    const instance = createEditor(html);
    caretAfter(instance, 'Beta');
    instance.commands.splitListItem(item);
    slashCode(instance);
    expect(shape(instance.state.doc)).toBe(
      `${list}[${item}[paragraph:Alpha,${list}[${item}[paragraph:Beta]],codeBlock:],${item}[paragraph:Gamma]]`,
    );
    expect(caretBlock(instance)).toBe('codeBlock:');
  });

  it('from an empty item between two: replaces it and splits the list', () => {
    const instance = createEditor(html);
    caretAfter(instance, 'Beta');
    instance.commands.splitListItem(item);
    instance.commands.liftListItem(item);
    type(instance, '``` ');
    expect(shape(instance.state.doc)).toBe(
      `${list}[${item}[paragraph:Alpha,${list}[${item}[paragraph:Beta]]]] codeBlock: ${list}[${item}[paragraph:Gamma]]`,
    );
  });

  it('from a selection in the item text: only the selection becomes code', () => {
    const instance = createEditor(html);
    select(instance, 'lph');
    slashCode(instance);
    expect(shape(instance.state.doc)).toBe(
      `${list}[${item}[paragraph:A,codeBlock:lph,paragraph:a,${list}[${item}[paragraph:Beta]]],${item}[paragraph:Gamma]]`,
    );
    undoOnce(instance);
    expect(shape(instance.state.doc)).toBe(original());
  });

  it("from a selection of the item's whole text: replaces the item", () => {
    const instance = createEditor(html);
    select(instance, 'Gamma');
    slashCode(instance);
    expect(shape(instance.state.doc)).toBe(
      `${list}[${item}[paragraph:Alpha,${list}[${item}[paragraph:Beta]]]] codeBlock:Gamma`,
    );
  });

  it('Backspace in the empty block makes it an empty line of the item again', () => {
    const instance = createEditor(html);
    caretAfter(instance, 'Beta');
    slashCode(instance);
    instance.commands.keyboardShortcut('Backspace');
    expect(shape(instance.state.doc)).toBe(
      `${list}[${item}[paragraph:Alpha,${list}[${item}[paragraph:Beta,paragraph:]]],${item}[paragraph:Gamma]]`,
    );
  });
});

describe('a code block outside a list', () => {
  it('after Umschalt+Enter: the line becomes the block, the text above stays', () => {
    const instance = createEditor('<p>Alpha</p><p>Ende</p>');
    caretAfter(instance, 'Alpha');
    instance.commands.setHardBreak();
    slashCode(instance);
    expect(shape(instance.state.doc)).toBe('paragraph:Alpha codeBlock: paragraph:Ende');
    expect(caretBlock(instance)).toBe('codeBlock:');
  });

  it('on an empty line between two lines: splits the paragraph around it', () => {
    const instance = createEditor('<p>Alpha<br><br>Omega</p>');
    caretAfter(instance, 'Alpha');
    instance.commands.setTextSelection(instance.state.selection.from + 1);
    type(instance, '``` ');
    expect(shape(instance.state.doc)).toBe('paragraph:Alpha codeBlock: paragraph:Omega');
  });

  it('a paragraph with text still turns into the block', () => {
    const instance = createEditor('<p>echo hallo</p>');
    caretAfter(instance, 'hallo');
    slashCode(instance);
    expect(shape(instance.state.doc)).toBe('codeBlock:echo hallo');
  });

  it('an empty paragraph turns into the block, and the fence still works', () => {
    const instance = createEditor('<p>Alpha</p><p></p>');
    instance.commands.setTextSelection(instance.state.doc.content.size - 1);
    type(instance, '```python ');
    expect(shape(instance.state.doc)).toBe('paragraph:Alpha codeBlock:');
    expect(instance.state.selection.$from.parent.attrs.language).toBe('python');
  });

  it('a fence after text on the same line is just text', () => {
    const instance = createEditor('<p>Alpha</p>');
    caretAfter(instance, 'Alpha');
    type(instance, ' ``` ');
    expect(shape(instance.state.doc)).toBe('paragraph:Alpha ``` ');
  });

  it('a selection inside a paragraph becomes code, and only the selection', () => {
    const instance = createEditor('<p>vorher npm test nachher</p>');
    select(instance, 'npm test');
    slashCode(instance);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:vorher  codeBlock:npm test paragraph: nachher',
    );
  });

  it('the command inside a code block still turns it back into a paragraph', () => {
    const instance = createEditor('<pre><code>x = 1</code></pre>');
    caretAfter(instance, 'x');
    slashCode(instance);
    expect(shape(instance.state.doc)).toBe('paragraph:x = 1');
  });

  it('asking whether it can changes nothing', () => {
    const instance = createEditor('<ul><li><p>Alpha</p></li></ul>');
    caretAfter(instance, 'Alpha');
    const before = instance.state.doc;
    expect(instance.can().toggleCodeBlock()).toBe(true);
    expect(instance.state.doc).toBe(before);
  });
});

describe('"Umwandeln in" from the handle (issue #284) is unchanged', () => {
  it('takes the item out of its list and turns its text into code', () => {
    const instance = createEditor('<ul><li><p>Eins</p></li><li><p>Zwei</p></li></ul>');
    let itemPos = -1;
    instance.state.doc.descendants((node, pos) => {
      if (itemPos < 0 && node.type.name === 'listItem' && node.textContent === 'Zwei') {
        itemPos = pos;
      }
      return itemPos < 0;
    });
    expect(turnBlockInto(instance, itemPos, codeEntry)).toBe(true);
    expect(shape(instance.state.doc)).toBe('bulletList[listItem[paragraph:Eins]] codeBlock:Zwei');
  });
});
