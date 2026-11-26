// @vitest-environment jsdom
import { Editor, Extension } from '@tiptap/core';
import { history, undo } from '@tiptap/pm/history';
import { type Node as PmNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { type BlockCatalogEntry, coreStructureBlocks, listBlocks } from './block-catalog';
import { blockContentSelection, runOnBlock } from './block-target';
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
  const found = [...coreStructureBlocks, ...listBlocks].find((candidate) => candidate.id === id);
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
