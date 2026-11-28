// @vitest-environment jsdom
import { Editor, Extension } from '@tiptap/core';
import { history, undo } from '@tiptap/pm/history';
import { type Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from './extensions';

/**
 * Issue #319: Backspace or Delete next to a code block joined it with its
 * neighbour, and the code's lines leaked into the page as paragraph text.
 * These press the real keys through the editor's own key handling (Tiptap's
 * `keyboardShortcut` command would drop a caret that only moves); the Yjs undo
 * and the browser's own keys are proven in `e2e/tests/editor.spec.ts`.
 */

let editor: Editor | null = null;

/** The page editor's undo comes with Yjs; the plain history stands in here. */
const History = Extension.create({
  name: 'testHistory',
  addProseMirrorPlugins: () => [history()],
});

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const CODE = '<pre><code>line1\nline2\nline3</code></pre>';
const IMAGE = '<img src="https://example.org/a.png">';
const LIST = '<ul><li><p>A</p></li><li><p>B</p></li></ul>';
const EMPTY_CODE = '<pre data-block-id="codeblockid01"><code></code></pre>';
const CALLOUT = '<aside data-callout><p>Hint</p></aside>';

/** The document as `type:text`, containers as `type[...]`, a newline as `↵`. */
function shape(node: PmNode): string {
  if (node.isTextblock) {
    let text = '';
    node.forEach((child) => {
      text += child.isText ? (child.text ?? '').replaceAll('\n', '↵') : '⏎';
    });
    return `${node.type.name}:${text}`;
  }
  const children: string[] = [];
  node.forEach((child) => children.push(shape(child)));
  return node.type.name === 'doc'
    ? children.join(' | ')
    : `${node.type.name}[${children.join(',')}]`;
}

/** Where the caret stands: `type:text@offset`, or `[type]` for a selected block. */
function caret(instance: Editor): string {
  const { selection } = instance.state;
  if (selection instanceof NodeSelection) return `[${selection.node.type.name}]`;
  const { $from } = selection;
  return `${$from.parent.type.name}:${$from.parent.textContent.replaceAll('\n', '↵')}@${$from.parentOffset}`;
}

/** Opens `html` with the caret at the start or end of its `index`th text block. */
function open(html: string, index: number, at: 'start' | 'end'): Editor {
  editor = new Editor({ extensions: [...buildEditorExtensions(), History], content: html });
  const blocks: { pos: number; node: PmNode }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock) blocks.push({ pos, node });
    return true;
  });
  const block = blocks[index];
  if (block === undefined) throw new Error(`no text block ${index}`);
  const pos = block.pos + 1 + (at === 'start' ? 0 : block.node.content.size);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)));
  return editor;
}

/** Presses `key` the way the browser hands it to the editor. */
function press(instance: Editor, key: 'Backspace' | 'Delete'): void {
  const event = new KeyboardEvent('keydown', { key });
  instance.view.someProp('handleKeyDown', (handler) => handler(instance.view, event));
}

function undoOnce(instance: Editor): void {
  expect(undo(instance.state, instance.view.dispatch)).toBe(true);
}

describe('Backspace in an empty line above a code block', () => {
  it('removes only the line, under text', () => {
    const instance = open(`<p>Text</p><p></p>${CODE}`, 1, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe('paragraph:Text | codeBlock:line1↵line2↵line3');
    expect(caret(instance)).toBe('paragraph:Text@4');
    undoOnce(instance);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Text | paragraph: | codeBlock:line1↵line2↵line3',
    );
  });

  it('removes one line of several', () => {
    const instance = open(`<p>Text</p><p></p><p></p>${CODE}`, 2, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Text | paragraph: | codeBlock:line1↵line2↵line3',
    );
  });

  it('at the top of the page: the block moves up into the line', () => {
    const instance = open(`<p></p>${CODE}`, 0, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe('codeBlock:line1↵line2↵line3');
    expect(caret(instance)).toBe('codeBlock:line1↵line2↵line3@0');
    undoOnce(instance);
    expect(shape(instance.state.doc)).toBe('paragraph: | codeBlock:line1↵line2↵line3');
  });

  it('below a list: the line goes, the list and the block stay', () => {
    const instance = open(`${LIST}<p></p>${CODE}`, 2, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe(
      'bulletList[listItem[paragraph:A],listItem[paragraph:B]] | codeBlock:line1↵line2↵line3',
    );
    expect(caret(instance)).toBe('paragraph:B@1');
  });
});

describe('Delete above a code block', () => {
  it('in an empty line removes only the line', () => {
    const instance = open(`<p>Text</p><p></p>${CODE}`, 1, 'start');
    press(instance, 'Delete');
    expect(shape(instance.state.doc)).toBe('paragraph:Text | codeBlock:line1↵line2↵line3');
    expect(caret(instance)).toBe('codeBlock:line1↵line2↵line3@0');
  });

  it('at the end of text removes an empty line between, then nothing', () => {
    const instance = open(`<p>Text</p><p></p>${CODE}`, 0, 'end');
    press(instance, 'Delete');
    expect(shape(instance.state.doc)).toBe('paragraph:Text | codeBlock:line1↵line2↵line3');
    press(instance, 'Delete');
    expect(shape(instance.state.doc)).toBe('paragraph:Text | codeBlock:line1↵line2↵line3');
    expect(caret(instance)).toBe('paragraph:Text@4');
  });

  it('at the end of the last list point does not pull the code into it', () => {
    const instance = open(`${LIST}${CODE}`, 1, 'end');
    press(instance, 'Delete');
    expect(shape(instance.state.doc)).toBe(
      'bulletList[listItem[paragraph:A],listItem[paragraph:B]] | codeBlock:line1↵line2↵line3',
    );
  });

  it('at the end of a list point above a code block in that point changes nothing', () => {
    const instance = open('<ul><li><p>A</p><pre><code>x\ny</code></pre></li></ul>', 0, 'end');
    press(instance, 'Delete');
    expect(shape(instance.state.doc)).toBe('bulletList[listItem[paragraph:A,codeBlock:x↵y]]');
  });
});

describe('Backspace at the start of a code block with code in it', () => {
  it('after text: the caret goes to the end of the text, nothing joins', () => {
    const instance = open(`<p>Text</p>${CODE}`, 1, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe('paragraph:Text | codeBlock:line1↵line2↵line3');
    expect(caret(instance)).toBe('paragraph:Text@4');
  });

  it('after an empty line: the line goes and the block moves up', () => {
    const instance = open(`<p>Text</p><p></p>${CODE}`, 2, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe('paragraph:Text | codeBlock:line1↵line2↵line3');
    expect(caret(instance)).toBe('codeBlock:line1↵line2↵line3@0');
    undoOnce(instance);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Text | paragraph: | codeBlock:line1↵line2↵line3',
    );
  });

  it('as the first block of the page: nothing happens, it stays a code block', () => {
    const instance = open(`${CODE}<p>after</p>`, 0, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe('codeBlock:line1↵line2↵line3 | paragraph:after');
    expect(caret(instance)).toBe('codeBlock:line1↵line2↵line3@0');
  });

  it('after a list: the caret goes to the end of the last point', () => {
    const instance = open(`${LIST}${CODE}`, 2, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe(
      'bulletList[listItem[paragraph:A],listItem[paragraph:B]] | codeBlock:line1↵line2↵line3',
    );
    expect(caret(instance)).toBe('paragraph:B@1');
  });

  it('inside a list point: the caret goes to the end of the point text', () => {
    const instance = open('<ul><li><p>A</p><pre><code>x\ny</code></pre></li></ul>', 1, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe('bulletList[listItem[paragraph:A,codeBlock:x↵y]]');
    expect(caret(instance)).toBe('paragraph:A@1');
  });

  it('after a picture: the picture is selected, not deleted', () => {
    const instance = open(`${IMAGE}${CODE}`, 0, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe('image[] | codeBlock:line1↵line2↵line3');
    expect(caret(instance)).toBe('[image]');
  });

  it('after a callout: the caret goes to the end of its text', () => {
    const instance = open(`${CALLOUT}${CODE}`, 1, 'start');
    const before = shape(instance.state.doc);
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe(before);
    expect(caret(instance)).toBe('paragraph:Hint@4');
  });
});

describe('Backspace in an empty code block', () => {
  it.each([
    ['first on the page', `${EMPTY_CODE}<p>after</p>`, 0, 'paragraph: | paragraph:after'],
    ['after text', `<p>Text</p>${EMPTY_CODE}`, 1, 'paragraph:Text | paragraph:'],
    [
      'inside a list point (#318)',
      `<ul><li><p>A</p>${EMPTY_CODE}</li></ul>`,
      1,
      'bulletList[listItem[paragraph:A,paragraph:]]',
    ],
  ])('%s makes it an empty paragraph where it stands', (_name, html, index, expected) => {
    const instance = open(html, index, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe(expected);
    expect(caret(instance)).toBe('paragraph:@0');
    expect(instance.state.selection.$from.parent.attrs.blockId).toBe('codeblockid01');
  });
});

describe('below a code block', () => {
  it('Backspace at the start of text: the caret goes to the end of the code', () => {
    const instance = open(`${CODE}<p>after</p>`, 1, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe('codeBlock:line1↵line2↵line3 | paragraph:after');
    expect(caret(instance)).toBe('codeBlock:line1↵line2↵line3@17');
  });

  it('Backspace in an empty line removes it', () => {
    const instance = open(`${CODE}<p></p><p>after</p>`, 1, 'start');
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toBe('codeBlock:line1↵line2↵line3 | paragraph:after');
    expect(caret(instance)).toBe('codeBlock:line1↵line2↵line3@17');
  });

  it('Delete at the end of the code: an empty line below goes, text stays below', () => {
    const instance = open(`${CODE}<p></p><p>after</p>`, 0, 'end');
    press(instance, 'Delete');
    expect(shape(instance.state.doc)).toBe('codeBlock:line1↵line2↵line3 | paragraph:after');
    press(instance, 'Delete');
    expect(shape(instance.state.doc)).toBe('codeBlock:line1↵line2↵line3 | paragraph:after');
    expect(caret(instance)).toBe('codeBlock:line1↵line2↵line3@17');
  });

  it('Delete at the end of the code selects a picture below instead of deleting it', () => {
    const instance = open(`${CODE}${IMAGE}`, 0, 'end');
    press(instance, 'Delete');
    expect(shape(instance.state.doc)).toBe('codeBlock:line1↵line2↵line3 | image[]');
    expect(caret(instance)).toBe('[image]');
  });
});
