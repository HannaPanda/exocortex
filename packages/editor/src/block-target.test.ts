// @vitest-environment jsdom
import { Editor, Extension } from '@tiptap/core';
import { history, undo } from '@tiptap/pm/history';
import { type Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import {
  type BlockCatalogEntry,
  calloutBlocks,
  coreStructureBlocks,
  listBlocks,
} from './block-catalog';
import { blockContentSelection, runOnBlock, turnBlockInto } from './block-target';
import { buildEditorExtensions } from './extensions';

/**
 * Issue #229: the block handle's menu acts on its block, not on the caret.
 * The conversions are the catalog's own entries, run the way the menu runs
 * them, so a change to an entry is tested here too.
 */

let editor: Editor | null = null;

/**
 * The page editor's undo comes with collaboration (Yjs), which the client
 * injects; the plain history plugin stands in for it here. Both group by
 * content change, which is what the one-step claim rests on.
 */
const History = Extension.create({
  name: 'testHistory',
  addProseMirrorPlugins: () => [history()],
});

function createEditor(content: string): Editor {
  editor = new Editor({ extensions: [...buildEditorExtensions(), History], content });
  return editor;
}

function undoOnce(instance: Editor): void {
  expect(undo(instance.state, instance.view.dispatch)).toBe(true);
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function entry(id: string): BlockCatalogEntry {
  const found = [...coreStructureBlocks, ...listBlocks, ...calloutBlocks].find(
    (candidate) => candidate.id === id,
  );
  if (found === undefined) throw new Error(`no catalog entry ${id}`);
  return found;
}

/** Where the text block whose text is `text` starts, and the block itself. */
function textBlock(doc: PmNode, text: string): { pos: number; node: PmNode } {
  let found: { pos: number; node: PmNode } | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.isTextblock && node.textContent === text) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  if (found === null) throw new Error(`no text block ${text}`);
  return found;
}

/** Where the closest ancestor of type `type` around the text `text` starts. */
function around(doc: PmNode, text: string, type: string): number {
  const $pos = doc.resolve(textBlock(doc, text).pos + 1);
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === type) return $pos.before(depth);
  }
  throw new Error(`no ${type} around ${text}`);
}

function caretIn(instance: Editor, text: string): void {
  const at = textBlock(instance.state.doc, text).pos + 2;
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.create(instance.state.doc, at)),
  );
}

/** Text blocks as `type:text`, in document order. */
function blocks(instance: Editor): string[] {
  const out: string[] = [];
  instance.state.doc.descendants((node) => {
    if (node.isTextblock) out.push(`${node.type.name}:${node.textContent}`);
    return true;
  });
  return out;
}

/** The texts carrying a text colour. */
function coloured(instance: Editor): string[] {
  const out: string[] = [];
  instance.state.doc.descendants((node) => {
    if (node.isText && node.marks.some((mark) => mark.type.name === 'textColor')) {
      out.push(node.text ?? '');
    }
    return true;
  });
  return out;
}

describe('blockContentSelection', () => {
  it('selects all the text of a text block', () => {
    const instance = createEditor('<p>Eins</p><p>Zwei Wörter</p>');
    const { pos } = textBlock(instance.state.doc, 'Zwei Wörter');
    const selection = blockContentSelection(instance.state.doc, pos);
    expect(selection).toBeInstanceOf(TextSelection);
    expect(instance.state.doc.textBetween(selection?.from ?? 0, selection?.to ?? 0)).toBe(
      'Zwei Wörter',
    );
  });

  it('spans a container from its first to its last text block', () => {
    const instance = createEditor(
      '<ul><li><p>Zwei</p><ul><li><p>Unter</p></li></ul></li></ul><blockquote><p>A</p><p>B</p></blockquote>',
    );
    const { doc } = instance.state;
    const item = blockContentSelection(doc, around(doc, 'Zwei', 'listItem'));
    expect(doc.textBetween(item?.from ?? 0, item?.to ?? 0, '|')).toBe('Zwei|Unter');
    const quote = blockContentSelection(doc, around(doc, 'A', 'blockquote'));
    expect(doc.textBetween(quote?.from ?? 0, quote?.to ?? 0, '|')).toBe('A|B');
  });

  it('selects a block without text as a node, and nothing where no block is', () => {
    const instance = createEditor('<p>Oben</p><hr><p>Unten</p>');
    const { doc } = instance.state;
    const rulePos = textBlock(doc, 'Oben').node.nodeSize;
    expect(blockContentSelection(doc, rulePos)).toBeInstanceOf(NodeSelection);
    expect(blockContentSelection(doc, doc.content.size + 4)).toBeNull();
    expect(blockContentSelection(doc, -1)).toBeNull();
  });

  it('gives an empty paragraph a caret inside it', () => {
    const instance = createEditor('<p>Oben</p><p></p>');
    const pos = textBlock(instance.state.doc, 'Oben').node.nodeSize;
    const selection = blockContentSelection(instance.state.doc, pos);
    expect(selection?.empty).toBe(true);
    expect(selection?.from).toBe(pos + 1);
  });
});

describe('runOnBlock', () => {
  it('turns the block it is given, not the one holding the caret', () => {
    const instance = createEditor('<p>Alpha</p><p>Beta</p><p>Gamma</p>');
    caretIn(instance, 'Alpha');
    const { pos } = textBlock(instance.state.doc, 'Gamma');
    expect(runOnBlock(instance, pos, () => entry('heading-2').run(instance))).toBe(true);
    expect(blocks(instance)).toEqual(['paragraph:Alpha', 'paragraph:Beta', 'heading:Gamma']);
    // The caret is left collapsed at the end of the changed block.
    const { selection } = instance.state;
    expect(selection.empty).toBe(true);
    expect(selection.$from.parent.textContent).toBe('Gamma');
    expect(selection.$from.parentOffset).toBe('Gamma'.length);
  });

  it('colours every word of the block and nothing else', () => {
    const instance = createEditor('<p>Alpha</p><p>Beta zwei Wörter</p>');
    caretIn(instance, 'Alpha');
    const { pos } = textBlock(instance.state.doc, 'Beta zwei Wörter');
    runOnBlock(instance, pos, () => instance.chain().setTextColor('red').run());
    expect(coloured(instance)).toEqual(['Beta zwei Wörter']);
    expect(instance.state.selection.empty).toBe(true);
  });

  it('takes the action back in one undo step', () => {
    const instance = createEditor('<p>Alpha</p><p>Beta</p>');
    caretIn(instance, 'Alpha');
    const { pos } = textBlock(instance.state.doc, 'Beta');
    runOnBlock(instance, pos, () => entry('heading-2').run(instance));
    runOnBlock(instance, textBlock(instance.state.doc, 'Beta').pos, () =>
      instance.chain().setTextColor('blue').run(),
    );
    undoOnce(instance);
    expect(coloured(instance)).toEqual([]);
    expect(blocks(instance)).toEqual(['paragraph:Alpha', 'heading:Beta']);
    undoOnce(instance);
    expect(blocks(instance)).toEqual(['paragraph:Alpha', 'paragraph:Beta']);
  });

  it('colours a nested list item without its parent', () => {
    const instance = createEditor(
      '<p>Oben</p><ul><li><p>Eins</p></li><li><p>Zwei</p><ul><li><p>Unter</p></li></ul></li></ul>',
    );
    caretIn(instance, 'Oben');
    const pos = around(instance.state.doc, 'Unter', 'listItem');
    runOnBlock(instance, pos, () => instance.chain().setTextColor('green').run());
    expect(coloured(instance)).toEqual(['Unter']);
  });

  it('numbers the list an item stands in and keeps its sub-list as it was', () => {
    const instance = createEditor(
      '<p>Oben</p><ul><li><p>Eins</p></li><li><p>Zwei</p><ul><li><p>Unter</p></li></ul></li></ul>',
    );
    caretIn(instance, 'Oben');
    const pos = around(instance.state.doc, 'Zwei', 'listItem');
    runOnBlock(instance, pos, () => entry('ordered-list').run(instance));
    const outer = instance.state.doc.child(1);
    expect(outer.type.name).toBe('orderedList');
    expect(outer.lastChild?.lastChild?.type.name).toBe('bulletList');
    expect(blocks(instance)[0]).toBe('paragraph:Oben');
  });

  it('lifts a whole quote out with the quote toggle', () => {
    const instance = createEditor('<p>Oben</p><blockquote><p>A</p><p>B</p></blockquote>');
    caretIn(instance, 'Oben');
    const pos = around(instance.state.doc, 'A', 'blockquote');
    runOnBlock(instance, pos, () => entry('blockquote').run(instance));
    const names: string[] = [];
    instance.state.doc.forEach((node) => names.push(node.type.name));
    expect(names).toEqual(['paragraph', 'paragraph', 'paragraph']);
  });

  it('does nothing when the block is gone', () => {
    const instance = createEditor('<p>Alpha</p>');
    caretIn(instance, 'Alpha');
    let ran = false;
    expect(
      runOnBlock(instance, instance.state.doc.content.size + 10, () => {
        ran = true;
        return true;
      }),
    ).toBe(false);
    expect(ran).toBe(false);
  });
});

/** The document's structure, text blocks as `type:text`. */
function shape(node: PmNode): string {
  if (node.isTextblock) return `${node.type.name}:${node.textContent}`;
  const children: string[] = [];
  node.forEach((child) => children.push(shape(child)));
  return node.type.name === 'doc' ? children.join(' ') : `${node.type.name}[${children.join(',')}]`;
}

/** Where the list item whose own text is `text` starts. */
function itemOf(doc: PmNode, text: string): number {
  const $pos = doc.resolve(textBlock(doc, text).pos);
  return $pos.before($pos.depth);
}

/** Turns the item with the text `text` the way the handle's menu does. */
function turnItem(instance: Editor, text: string, id: string): boolean {
  return turnBlockInto(instance, itemOf(instance.state.doc, text), entry(id));
}

function expectCaretAtEndOf(instance: Editor, text: string, type = 'paragraph'): void {
  const { selection } = instance.state;
  expect(selection.empty).toBe(true);
  expect(selection.$from.parent.type.name).toBe(type);
  expect(selection.$from.parent.textContent).toBe(text);
  expect(selection.$from.parentOffset).toBe(text.length);
}

const BULLETS = '<p>Oben</p><ul><li><p>Eins</p></li><li><p>Zwei</p></li><li><p>Drei</p></li></ul>';
const WITH_SUB_ITEMS =
  '<p>Oben</p><ul><li><p>Eins</p></li><li><p>Zwei</p><ul><li><p>Unter</p></li></ul></li><li><p>Drei</p></li></ul>';

describe('turnBlockInto a paragraph, on a list item (issue #284)', () => {
  it('takes the first item out above the rest of the list', () => {
    const instance = createEditor(BULLETS);
    caretIn(instance, 'Oben');
    expect(turnItem(instance, 'Eins', 'paragraph')).toBe(true);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Oben paragraph:Eins bulletList[listItem[paragraph:Zwei],listItem[paragraph:Drei]]',
    );
    expectCaretAtEndOf(instance, 'Eins');
  });

  it('splits the list around an item in the middle', () => {
    const instance = createEditor(BULLETS);
    caretIn(instance, 'Oben');
    expect(turnItem(instance, 'Zwei', 'paragraph')).toBe(true);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Oben bulletList[listItem[paragraph:Eins]] paragraph:Zwei bulletList[listItem[paragraph:Drei]]',
    );
    expectCaretAtEndOf(instance, 'Zwei');
  });

  it('takes the last item out below the list', () => {
    const instance = createEditor(BULLETS);
    caretIn(instance, 'Oben');
    expect(turnItem(instance, 'Drei', 'paragraph')).toBe(true);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Oben bulletList[listItem[paragraph:Eins],listItem[paragraph:Zwei]] paragraph:Drei',
    );
    expectCaretAtEndOf(instance, 'Drei');
  });

  it('keeps the sub-items as a list directly underneath', () => {
    const instance = createEditor(WITH_SUB_ITEMS);
    caretIn(instance, 'Oben');
    expect(turnItem(instance, 'Zwei', 'paragraph')).toBe(true);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Oben bulletList[listItem[paragraph:Eins]] paragraph:Zwei bulletList[listItem[paragraph:Unter]] bulletList[listItem[paragraph:Drei]]',
    );
    expectCaretAtEndOf(instance, 'Zwei');
  });

  it('turns a sub-item into a paragraph of the item above it', () => {
    const instance = createEditor(WITH_SUB_ITEMS);
    caretIn(instance, 'Oben');
    expect(turnItem(instance, 'Unter', 'paragraph')).toBe(true);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Oben bulletList[listItem[paragraph:Eins],listItem[paragraph:Zwei,paragraph:Unter],listItem[paragraph:Drei]]',
    );
  });

  it('starts the second half of a numbered list again at one', () => {
    const instance = createEditor(
      '<ol start="4"><li><p>Eins</p></li><li><p>Zwei</p></li><li><p>Drei</p></li></ol>',
    );
    expect(turnItem(instance, 'Zwei', 'paragraph')).toBe(true);
    const { doc } = instance.state;
    expect(shape(doc)).toBe(
      'orderedList[listItem[paragraph:Eins]] paragraph:Zwei orderedList[listItem[paragraph:Drei]]',
    );
    expect(doc.child(0).attrs.start).toBe(4);
    expect(doc.child(2).attrs.start).toBe(1);
  });

  it('turns a task into a line without its tick', () => {
    const instance = createEditor(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Eins</p></li><li data-type="taskItem" data-checked="true"><p>Zwei</p></li><li data-type="taskItem"><p>Drei</p></li></ul>',
    );
    expect(turnItem(instance, 'Zwei', 'paragraph')).toBe(true);
    expect(shape(instance.state.doc)).toBe(
      'taskList[taskItem[paragraph:Eins]] paragraph:Zwei taskList[taskItem[paragraph:Drei]]',
    );
    expect(instance.state.doc.child(0).child(0).attrs.checked).toBe(true);
  });

  it('is taken back in one undo step', () => {
    const instance = createEditor(WITH_SUB_ITEMS);
    caretIn(instance, 'Oben');
    const before = shape(instance.state.doc);
    turnItem(instance, 'Zwei', 'paragraph');
    undoOnce(instance);
    expect(shape(instance.state.doc)).toBe(before);
  });
});

describe('turnBlockInto another block, on a list item (issue #284)', () => {
  it('makes a heading of the item and keeps its sub-items under it', () => {
    const instance = createEditor(WITH_SUB_ITEMS);
    caretIn(instance, 'Oben');
    expect(turnItem(instance, 'Zwei', 'heading-2')).toBe(true);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Oben bulletList[listItem[paragraph:Eins]] heading:Zwei bulletList[listItem[paragraph:Unter]] bulletList[listItem[paragraph:Drei]]',
    );
    expectCaretAtEndOf(instance, 'Zwei', 'heading');
  });

  it('makes a code block of the item', () => {
    const instance = createEditor(BULLETS);
    expect(turnItem(instance, 'Zwei', 'code-block')).toBe(true);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Oben bulletList[listItem[paragraph:Eins]] codeBlock:Zwei bulletList[listItem[paragraph:Drei]]',
    );
  });

  it('puts the item in a quote or a callout, which did nothing before', () => {
    const quoted = createEditor(WITH_SUB_ITEMS);
    expect(turnItem(quoted, 'Zwei', 'blockquote')).toBe(true);
    expect(shape(quoted.state.doc)).toBe(
      'paragraph:Oben bulletList[listItem[paragraph:Eins]] blockquote[paragraph:Zwei] bulletList[listItem[paragraph:Unter]] bulletList[listItem[paragraph:Drei]]',
    );
    expectCaretAtEndOf(quoted, 'Zwei');
    quoted.destroy();

    const boxed = createEditor(BULLETS);
    expect(turnItem(boxed, 'Drei', 'callout')).toBe(true);
    expect(shape(boxed.state.doc)).toBe(
      'paragraph:Oben bulletList[listItem[paragraph:Eins],listItem[paragraph:Zwei]] callout[paragraph:Drei]',
    );
    // A new box starts with the light bulb and no heading (issue #306).
    expect(boxed.state.doc.lastChild?.attrs.emoji).toBe('💡');
  });

  it('takes a conversion back in one undo step', () => {
    const instance = createEditor(WITH_SUB_ITEMS);
    caretIn(instance, 'Oben');
    const before = shape(instance.state.doc);
    turnItem(instance, 'Zwei', 'blockquote');
    undoOnce(instance);
    expect(shape(instance.state.doc)).toBe(before);
  });

  it('toggles the list off for an item of that kind', () => {
    const instance = createEditor(WITH_SUB_ITEMS);
    expect(turnItem(instance, 'Zwei', 'bullet-list')).toBe(true);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Oben bulletList[listItem[paragraph:Eins]] paragraph:Zwei bulletList[listItem[paragraph:Unter]] bulletList[listItem[paragraph:Drei]]',
    );
  });

  it('still numbers the whole list a bullet item stands in', () => {
    const instance = createEditor(WITH_SUB_ITEMS);
    expect(turnItem(instance, 'Zwei', 'ordered-list')).toBe(true);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Oben orderedList[listItem[paragraph:Eins],listItem[paragraph:Zwei,bulletList[listItem[paragraph:Unter]]],listItem[paragraph:Drei]]',
    );
  });

  it('makes an item with sub-items a task of its own, and back', () => {
    const instance = createEditor(WITH_SUB_ITEMS);
    expect(turnItem(instance, 'Zwei', 'task-list')).toBe(true);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Oben bulletList[listItem[paragraph:Eins]] taskList[taskItem[paragraph:Zwei,bulletList[listItem[paragraph:Unter]]]] bulletList[listItem[paragraph:Drei]]',
    );
    expectCaretAtEndOf(instance, 'Zwei');

    expect(turnItem(instance, 'Zwei', 'ordered-list')).toBe(true);
    expect(shape(instance.state.doc)).toBe(
      'paragraph:Oben bulletList[listItem[paragraph:Eins]] orderedList[listItem[paragraph:Zwei,bulletList[listItem[paragraph:Unter]]]] bulletList[listItem[paragraph:Drei]]',
    );
  });

  it('leaves a block that is no list item to runOnBlock', () => {
    const instance = createEditor('<p>Alpha</p><p>Beta</p>');
    caretIn(instance, 'Alpha');
    expect(
      turnBlockInto(instance, textBlock(instance.state.doc, 'Beta').pos, entry('heading-1')),
    ).toBe(true);
    expect(blocks(instance)).toEqual(['paragraph:Alpha', 'heading:Beta']);
  });
});
