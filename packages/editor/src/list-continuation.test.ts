// @vitest-environment jsdom
import { Editor, Extension } from '@tiptap/core';
import { history, undo, undoDepth } from '@tiptap/pm/history';
import { type Node as PmNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from './extensions';
import {
  backspaceBelowListTransaction,
  findListContinuation,
  LIST_CONTINUATION_MAX_GAP,
  LIST_MARKER_STYLED_DEPTH,
  listMarkerLevel,
  listMarkerText,
} from './list-continuation';

/**
 * Issue #240: an empty line below a list, with a picture or another block in
 * between, previews the next point and `Tab` continues the list. The key runs
 * through the editor's own keymap here, as it does in the browser.
 */

let editor: Editor | null = null;

const History = Extension.create({
  name: 'testHistory',
  addProseMirrorPlugins: () => [history()],
});

function createEditor(content: string): Editor {
  editor = new Editor({
    extensions: buildEditorExtensions({ additionalExtensions: [History] }),
    content,
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const IMAGE = '<img src="https://example.org/bild.png">';

/** The position in front of the `nth` empty paragraph (0-based) of the document. */
function emptyParagraphPos(instance: Editor, nth = 0): number {
  let found = -1;
  let seen = 0;
  instance.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type.name === 'paragraph' && node.content.size === 0) {
      if (seen === nth) {
        found = pos;
        return false;
      }
      seen += 1;
    }
    return true;
  });
  expect(found).toBeGreaterThanOrEqual(0);
  return found;
}

/** Puts the caret into the `nth` empty paragraph. */
function caretInEmpty(instance: Editor, nth = 0): number {
  const pos = emptyParagraphPos(instance, nth);
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.create(instance.state.doc, pos + 1)),
  );
  return pos;
}

/** Puts the caret at the end of the text block whose text is `text`. */
function caretAfter(instance: Editor, text: string): void {
  let found = -1;
  instance.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isTextblock && node.textContent === text) {
      found = pos + 1 + node.content.size;
      return false;
    }
    return true;
  });
  expect(found).toBeGreaterThan(0);
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.create(instance.state.doc, found)),
  );
}

function press(instance: Editor, key: string, shiftKey = false): boolean {
  const event = new KeyboardEvent('keydown', { key, shiftKey });
  return (
    instance.view.someProp('handleKeyDown', (handler) => handler(instance.view, event)) ?? false
  );
}

/** The document's shape: node names, text and the attributes that matter here. */
function shape(node: PmNode): unknown {
  if (node.isText) return node.text;
  const children: unknown[] = [];
  node.forEach((child) => children.push(shape(child)));
  const start: unknown = node.attrs.start;
  const name =
    node.type.name === 'orderedList' && typeof start === 'number' && start !== 1
      ? `orderedList(${start})`
      : node.type.name;
  return children.length === 0 ? name : { [name]: children };
}

function ghost(instance: Editor): HTMLElement | null {
  return instance.view.dom.querySelector<HTMLElement>('.exocortex-list-ghost');
}

describe('findListContinuation', () => {
  it('finds the list across a picture and stops after too many blocks or at a heading', () => {
    const instance = createEditor(`<ul><li><p>eins</p></li></ul>${IMAGE}<p></p>`);
    const pos = emptyParagraphPos(instance);
    expect(findListContinuation(instance.state.doc, pos)?.action.type).toBe('newList');

    const between = Array.from({ length: LIST_CONTINUATION_MAX_GAP + 1 }, () => IMAGE).join('');
    const far = createEditor(`<ul><li><p>eins</p></li></ul>${between}<p></p>`);
    expect(findListContinuation(far.state.doc, emptyParagraphPos(far))).toBeNull();

    const headed = createEditor(`<ul><li><p>eins</p></li></ul><h2>Neu</h2><p></p>`);
    expect(findListContinuation(headed.state.doc, emptyParagraphPos(headed))).toBeNull();
  });

  it('offers nothing for a line with text, a point of its own or a table cell', () => {
    const withText = createEditor(`<ul><li><p>eins</p></li></ul><p>Text</p>`);
    let textPos = -1;
    withText.state.doc.forEach((node, offset) => {
      if (node.type.name === 'paragraph') textPos = offset;
    });
    expect(findListContinuation(withText.state.doc, textPos)).toBeNull();

    const ownPoint = createEditor(`<ul><li><p>eins</p></li><li><p></p></li></ul>`);
    expect(findListContinuation(ownPoint.state.doc, emptyParagraphPos(ownPoint))).toBeNull();

    const inTable = createEditor(
      `<table><tbody><tr><td><ul><li><p>eins</p></li></ul><p></p></td><td><p>b</p></td></tr></tbody></table>`,
    );
    expect(findListContinuation(inTable.state.doc, emptyParagraphPos(inTable))).toBeNull();
  });
});

describe('Tab in an empty line below a list (issue #240)', () => {
  it('starts the next point after the picture and leaves the picture where it was', () => {
    const instance = createEditor(`<ul><li><p>eins</p></li></ul>${IMAGE}<p></p>`);
    caretInEmpty(instance);

    expect(ghost(instance)?.getAttribute('data-list-ghost')).toBe('bullet');
    expect(ghost(instance)?.getAttribute('data-list-ghost-hint')).toContain('Tab');
    expect(press(instance, 'Tab')).toBe(true);

    expect(shape(instance.state.doc)).toEqual({
      doc: [
        { bulletList: [{ listItem: [{ paragraph: ['eins'] }] }] },
        'image',
        { bulletList: [{ listItem: ['paragraph'] }] },
      ],
    });
    // The caret is in the new point, and the preview is gone with the line.
    expect(instance.state.selection.$from.node(-1).type.name).toBe('listItem');
    expect(ghost(instance)).toBeNull();
  });

  it('counts a numbered list on', () => {
    const instance = createEditor(
      `<ol><li><p>eins</p></li><li><p>zwei</p></li><li><p>drei</p></li></ol>${IMAGE}<p></p>`,
    );
    caretInEmpty(instance);
    expect(ghost(instance)?.getAttribute('data-list-ghost-marker')).toBe('4.');
    press(instance, 'Tab');
    const last = instance.state.doc.lastChild;
    expect(last?.type.name).toBe('orderedList');
    expect(last?.attrs.start).toBe(4);
  });

  it('keeps a task a task', () => {
    const instance = createEditor(
      `<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>erledigt</p></li></ul><blockquote><p>Zitat</p></blockquote><p></p>`,
    );
    caretInEmpty(instance);
    expect(ghost(instance)?.getAttribute('data-list-ghost')).toBe('task');
    press(instance, 'Tab');
    const last = instance.state.doc.lastChild;
    expect(last?.type.name).toBe('taskList');
    expect(last?.firstChild?.type.name).toBe('taskItem');
    expect(last?.firstChild?.attrs.checked).toBe(false);
  });

  it('continues at the level of the last point when nothing stands between', () => {
    const instance = createEditor(
      `<ul><li><p>eins</p><ul><li><p>unter</p></li></ul></li></ul><p></p>`,
    );
    caretInEmpty(instance);
    expect(ghost(instance)?.getAttribute('style')).toContain('--exocortex-list-ghost-lists: 2');
    press(instance, 'Tab');
    expect(shape(instance.state.doc)).toEqual({
      doc: [
        {
          bulletList: [
            {
              listItem: [
                { paragraph: ['eins'] },
                {
                  bulletList: [
                    { listItem: [{ paragraph: ['unter'] }] },
                    { listItem: ['paragraph'] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('continues at the level of the list beside the picture when one stands between', () => {
    const instance = createEditor(
      `<ul><li><p>eins</p><ul><li><p>unter</p></li></ul></li></ul>${IMAGE}<p></p>`,
    );
    caretInEmpty(instance);
    press(instance, 'Tab');
    expect(shape(instance.state.doc.lastChild as PmNode)).toEqual({
      bulletList: [{ listItem: ['paragraph'] }],
    });
  });

  it('turns an empty line below a picture inside a point into the next point', () => {
    const instance = createEditor(
      `<ol><li><p>eins</p>${IMAGE}<p></p></li><li><p>zwei</p></li></ol>`,
    );
    caretInEmpty(instance);
    expect(ghost(instance)?.getAttribute('data-list-ghost-marker')).toBe('2.');
    press(instance, 'Tab');
    expect(shape(instance.state.doc)).toEqual({
      doc: [
        {
          orderedList: [
            { listItem: [{ paragraph: ['eins'] }, 'image'] },
            { listItem: ['paragraph'] },
            { listItem: [{ paragraph: ['zwei'] }] },
          ],
        },
      ],
    });
  });

  it('keeps the line’s block id and is taken back by one undo', () => {
    const id = 'leerezeile01';
    const instance = createEditor(
      `<ul><li><p>eins</p></li></ul>${IMAGE}<p data-block-id="${id}"></p>`,
    );
    const pos = caretInEmpty(instance);
    expect(instance.state.doc.nodeAt(pos)?.attrs.blockId).toBe(id);
    const before = shape(instance.state.doc);

    press(instance, 'Tab');
    expect(instance.state.selection.$from.parent.attrs.blockId).toBe(id);

    // One step back is the whole continuation, and the line is the same line.
    expect(undo(instance.state, instance.view.dispatch)).toBe(true);
    expect(shape(instance.state.doc)).toEqual(before);
    expect(instance.state.doc.lastChild?.attrs.blockId).toBe(id);
    expect(undoDepth(instance.state)).toBe(0);
  });

  it('leaves the preview out of the document and out of a read-only editor', () => {
    const instance = createEditor(`<ul><li><p>eins</p></li></ul>${IMAGE}<p></p>`);
    caretInEmpty(instance);
    expect(ghost(instance)).not.toBeNull();
    expect(instance.getHTML()).not.toContain('list-ghost');

    instance.setEditable(false);
    expect(ghost(instance)).toBeNull();
    expect(press(instance, 'Tab')).toBe(false);
  });

  it('leaves typing alone: a character makes the line a paragraph', () => {
    const instance = createEditor(`<ul><li><p>eins</p></li></ul>${IMAGE}<p></p>`);
    caretInEmpty(instance);
    instance.commands.insertContent('Text');
    expect(instance.state.doc.lastChild?.type.name).toBe('paragraph');
    expect(ghost(instance)).toBeNull();
  });
});

describe('Backspace in an empty line below a list (issue #302)', () => {
  /** Where the caret stands: the text of its block and its offset in it. */
  function caret(instance: Editor): { text: string; offset: number; empty: boolean } {
    const { selection } = instance.state;
    return {
      text: selection.$from.parent.textContent,
      offset: selection.$from.parentOffset,
      empty: selection.empty,
    };
  }

  const LISTS = [
    ['bullet', '<ul><li><p>eins</p></li><li><p>zwei</p></li></ul>', 'bulletList'],
    ['numbered', '<ol><li><p>eins</p></li><li><p>zwei</p></li></ol>', 'orderedList'],
    [
      'task',
      '<ul data-type="taskList"><li data-type="taskItem"><p>eins</p></li><li data-type="taskItem"><p>zwei</p></li></ul>',
      'taskList',
    ],
  ] as const;

  for (const [kind, list, type] of LISTS) {
    it(`removes the line and puts the caret after the last ${kind} point in one press`, () => {
      const instance = createEditor(`${list}<p></p>`);
      caretInEmpty(instance);
      expect(ghost(instance)).not.toBeNull();

      expect(press(instance, 'Backspace')).toBe(true);
      expect(instance.state.doc.childCount).toBe(1);
      expect(instance.state.doc.firstChild?.type.name).toBe(type);
      expect(instance.state.doc.firstChild?.childCount).toBe(2);
      expect(caret(instance)).toEqual({ text: 'zwei', offset: 4, empty: true });
      expect(ghost(instance)).toBeNull();
    });
  }

  it('does the same in the middle of the page, and the text below stays where it was', () => {
    const instance = createEditor(
      `<p>oben</p><ul><li><p>eins</p></li><li><p>zwei</p></li></ul><p></p><p>unten</p>`,
    );
    caretInEmpty(instance);
    press(instance, 'Backspace');
    expect(shape(instance.state.doc)).toEqual({
      doc: [
        { paragraph: ['oben'] },
        {
          bulletList: [
            { listItem: [{ paragraph: ['eins'] }] },
            { listItem: [{ paragraph: ['zwei'] }] },
          ],
        },
        { paragraph: ['unten'] },
      ],
    });
    expect(caret(instance)).toEqual({ text: 'zwei', offset: 4, empty: true });
  });

  it('goes down to the last sub-point, from below the list and from inside a point', () => {
    const nested = `<ul><li><p>eins</p><ul><li><p>unter</p></li></ul></li></ul>`;
    const below = createEditor(`${nested}<p></p>`);
    caretInEmpty(below);
    press(below, 'Backspace');
    expect(caret(below)).toEqual({ text: 'unter', offset: 5, empty: true });
    expect(below.state.doc.childCount).toBe(1);

    // The line a reader is left with inside a point, below its sub-list.
    const inside = createEditor(
      `<ul><li><p>eins</p><ul><li><p>unter</p></li></ul><p></p></li></ul>`,
    );
    caretInEmpty(inside);
    press(inside, 'Backspace');
    expect(caret(inside)).toEqual({ text: 'unter', offset: 5, empty: true });
    expect(shape(inside.state.doc)).toEqual({
      doc: [
        {
          bulletList: [
            {
              listItem: [
                { paragraph: ['eins'] },
                { bulletList: [{ listItem: [{ paragraph: ['unter'] }] }] },
              ],
            },
          ],
        },
      ],
    });
  });

  it('is taken back by one undo, line and caret', () => {
    const id = 'leerezeile02';
    const instance = createEditor(`<ul><li><p>eins</p></li></ul><p data-block-id="${id}"></p>`);
    caretInEmpty(instance);
    const before = shape(instance.state.doc);
    press(instance, 'Backspace');
    expect(undo(instance.state, instance.view.dispatch)).toBe(true);
    expect(shape(instance.state.doc)).toEqual(before);
    expect(instance.state.doc.lastChild?.attrs.blockId).toBe(id);
    expect(caret(instance)).toEqual({ text: '', offset: 0, empty: true });
    expect(undoDepth(instance.state)).toBe(0);
  });

  it('leaves every other Backspace to the keymap it had', () => {
    // Text below the list, a block between, no list, a point's own empty text.
    const cases = [
      `<ul><li><p>eins</p></li></ul>${IMAGE}<p></p>`,
      `<p>Text</p><p></p>`,
      `<ul><li><p>eins</p></li><li><p></p></li></ul>`,
    ];
    for (const html of cases) {
      const instance = createEditor(html);
      caretInEmpty(instance);
      expect(backspaceBelowListTransaction(instance.state)).toBeNull();
    }
    const withText = createEditor(`<ul><li><p>eins</p></li></ul><p>Text</p>`);
    withText.view.dispatch(
      withText.state.tr.setSelection(
        TextSelection.create(withText.state.doc, withText.state.doc.content.size - 5),
      ),
    );
    expect(withText.state.selection.$from.parent.textContent).toBe('Text');
    expect(backspaceBelowListTransaction(withText.state)).toBeNull();
  });
});

describe('the marker of a level (issue #250)', () => {
  it('goes disc, circle, square and 1., a., i., then round again', () => {
    const bullets = [1, 2, 3, 4, 5, 6].map((depth) => listMarkerText({ kind: 'bullet' }, depth));
    expect(bullets).toEqual(['•', '◦', '▪', '•', '◦', '▪']);
    const numbers = [1, 2, 3, 4].map((depth) =>
      listMarkerText({ kind: 'ordered', number: 4 }, depth),
    );
    expect(numbers).toEqual(['4.', 'd.', 'iv.', '4.']);
    expect(listMarkerText({ kind: 'task' }, 2)).toBe('');
  });

  it('counts like CSS: aa after z, digits where a numbering has no word', () => {
    expect(listMarkerText({ kind: 'ordered', number: 27 }, 2)).toBe('aa.');
    expect(listMarkerText({ kind: 'ordered', number: 1994 }, 3)).toBe('mcmxciv.');
    expect(listMarkerText({ kind: 'ordered', number: 0 }, 2)).toBe('0.');
    expect(listMarkerText({ kind: 'ordered', number: 4000 }, 3)).toBe('4000.');
  });

  it('keeps the last styled level below it, as the stylesheet does', () => {
    expect(listMarkerLevel(LIST_MARKER_STYLED_DEPTH + 1)).toBe(
      listMarkerLevel(LIST_MARKER_STYLED_DEPTH),
    );
    expect(listMarkerLevel(0)).toBe(0);
  });

  it('previews the marker of the level the new point will stand at', () => {
    // Directly below a sub-list: the point joins it, one level down.
    const nested = createEditor(
      `<ul><li><p>eins</p><ul><li><p>unter</p></li></ul></li></ul><p></p>`,
    );
    caretInEmpty(nested);
    expect(ghost(nested)?.getAttribute('data-list-ghost-marker')).toBe('◦');

    // Across a picture the point goes to the outer level again.
    const across = createEditor(
      `<ul><li><p>eins</p><ul><li><p>unter</p></li></ul></li></ul>${IMAGE}<p></p>`,
    );
    caretInEmpty(across);
    expect(ghost(across)?.getAttribute('data-list-ghost-marker')).toBe('•');

    // Inside a point of a numbered list under a bullet: second level, letters.
    const inside = createEditor(
      `<ul><li><p>oben</p><ol><li><p>eins</p>${IMAGE}<p></p></li></ol></li></ul>`,
    );
    caretInEmpty(inside);
    expect(ghost(inside)?.getAttribute('data-list-ghost-marker')).toBe('b.');

    // Under a task, a list is one level down although a task has no marker.
    const underTask = createEditor(
      `<ul data-type="taskList"><li data-type="taskItem"><p>Aufgabe</p><ul><li><p>a</p><ul><li><p>b</p></li></ul></li></ul></li></ul><p></p>`,
    );
    caretInEmpty(underTask);
    expect(ghost(underTask)?.getAttribute('data-list-ghost-marker')).toBe('▪');
  });
});

describe('Tab and Shift+Tab elsewhere are unchanged', () => {
  it('still nests a point under the one above it, and Shift+Tab lifts it back', () => {
    const instance = createEditor(`<ul><li><p>eins</p></li><li><p>zwei</p></li></ul>`);
    caretAfter(instance, 'zwei');
    expect(press(instance, 'Tab')).toBe(true);
    expect(shape(instance.state.doc)).toEqual({
      doc: [
        {
          bulletList: [
            {
              listItem: [
                { paragraph: ['eins'] },
                { bulletList: [{ listItem: [{ paragraph: ['zwei'] }] }] },
              ],
            },
          ],
        },
      ],
    });
    expect(press(instance, 'Tab', true)).toBe(true);
    expect(shape(instance.state.doc)).toEqual({
      doc: [
        {
          bulletList: [
            { listItem: [{ paragraph: ['eins'] }] },
            { listItem: [{ paragraph: ['zwei'] }] },
          ],
        },
      ],
    });
  });

  it('still moves to the next table cell', () => {
    const instance = createEditor(
      `<ul><li><p>eins</p></li></ul><table><tbody><tr><td><p>a</p></td><td><p>b</p></td></tr></tbody></table>`,
    );
    caretAfter(instance, 'a');
    expect(press(instance, 'Tab')).toBe(true);
    expect(instance.state.selection.$from.parent.textContent).toBe('b');
  });

  it('does nothing in an empty line with no list above it', () => {
    const instance = createEditor(`<p>Text</p><p></p>`);
    caretInEmpty(instance);
    expect(ghost(instance)).toBeNull();
    expect(press(instance, 'Tab')).toBe(false);
  });
});
