// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { buildEditorExtensions } from './extensions';
import { liftListItemOut, splitListAt } from './list-split';

/**
 * Issue #243: splitting a list and turning one of its items into ordinary
 * blocks. A dropped paragraph and the keyboard use these, and so will
 * "Absatz" in the handle's menu (issue #284).
 */

let editor: Editor | null = null;

function createEditor(content: string): Editor {
  editor = new Editor({ extensions: buildEditorExtensions(), content });
  // One change, so every block has its identifier before the test looks.
  editor.view.dispatch(editor.state.tr.insertText(' ', editor.state.doc.content.size - 1));
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** The top-level blocks: a text block by its text, a list by its items' texts. */
function shape(doc: PmNode): string[] {
  const out: string[] = [];
  doc.forEach((node) => {
    if (node.isTextblock) {
      out.push(`p:${node.textContent.trim()}`);
      return;
    }
    const inner: string[] = [];
    node.forEach((child) => inner.push(child.firstChild?.textContent.trim() ?? ''));
    out.push(`${node.type.name}[${inner.join(',')}]`);
  });
  return out;
}

/** The position of the list item whose own text is `text`. */
function itemPos(doc: PmNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isTextblock && node.textContent.trim() === text) {
      found = doc.resolve(pos).before();
      return false;
    }
    return true;
  });
  expect(found).toBeGreaterThanOrEqual(0);
  return found;
}

const LIST =
  '<ol><li><p>Eins</p></li><li><p>Zwei</p><ul><li><p>Zwei a</p></li></ul></li><li><p>Drei</p></li></ol><p>Ende</p>';

describe('splitting a list', () => {
  it('splits between two items, keeps the first half and starts the second afresh', () => {
    const instance = createEditor(LIST);
    const { doc } = instance.state;
    const listId: unknown = doc.child(0).attrs[BLOCK_ID_ATTRIBUTE];
    const tr = instance.state.tr;
    const at = splitListAt(tr, itemPos(doc, 'Zwei'));
    expect(at).not.toBeNull();
    instance.view.dispatch(tr);
    expect(shape(instance.state.doc)).toEqual([
      'orderedList[Eins]',
      'orderedList[Zwei,Drei]',
      'p:Ende',
    ]);
    const [first, second] = [instance.state.doc.child(0), instance.state.doc.child(1)];
    expect(first.attrs[BLOCK_ID_ATTRIBUTE]).toBe(listId);
    expect(second.attrs[BLOCK_ID_ATTRIBUTE]).not.toBe(listId);
    expect(second.attrs.start).toBe(1);
  });

  it('splits nothing at either end of the list', () => {
    const instance = createEditor(LIST);
    const { doc } = instance.state;
    const tr = instance.state.tr;
    expect(splitListAt(tr, 1)).toBe(0);
    expect(splitListAt(tr, doc.child(0).nodeSize - 1)).toBe(doc.child(0).nodeSize);
    expect(tr.docChanged).toBe(false);
    expect(splitListAt(tr, doc.child(0).nodeSize)).toBeNull();
  });
});

describe('lifting a list item out of its list', () => {
  it('turns the first item into a paragraph before the rest of the list', () => {
    const instance = createEditor(LIST);
    const tr = instance.state.tr;
    expect(liftListItemOut(tr, itemPos(instance.state.doc, 'Eins'))).not.toBeNull();
    instance.view.dispatch(tr);
    expect(shape(instance.state.doc)).toEqual(['p:Eins', 'orderedList[Zwei,Drei]', 'p:Ende']);
  });

  it('turns the last item into a paragraph after the rest of the list', () => {
    const instance = createEditor(LIST);
    const tr = instance.state.tr;
    liftListItemOut(tr, itemPos(instance.state.doc, 'Drei'));
    instance.view.dispatch(tr);
    expect(shape(instance.state.doc)).toEqual(['orderedList[Eins,Zwei]', 'p:Drei', 'p:Ende']);
  });

  it('splits the list around a middle item and keeps its sub-items as a list underneath', () => {
    const instance = createEditor(LIST);
    const before = instance.state.doc;
    const paragraphId: unknown = before.nodeAt(itemPos(before, 'Zwei') + 1)?.attrs[
      BLOCK_ID_ATTRIBUTE
    ];
    const tr = instance.state.tr;
    const lifted = liftListItemOut(tr, itemPos(before, 'Zwei'));
    expect(lifted).not.toBeNull();
    instance.view.dispatch(tr);
    expect(shape(instance.state.doc)).toEqual([
      'orderedList[Eins]',
      'p:Zwei',
      'bulletList[Zwei a]',
      'orderedList[Drei]',
      'p:Ende',
    ]);
    // The paragraph is the item's own, identifier and all.
    expect(instance.state.doc.child(1).attrs[BLOCK_ID_ATTRIBUTE]).toBe(paragraphId);
  });

  it('replaces a list of one item by its blocks', () => {
    const instance = createEditor(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Allein</p></li></ul><p>Ende</p>',
    );
    const tr = instance.state.tr;
    liftListItemOut(tr, itemPos(instance.state.doc, 'Allein'));
    instance.view.dispatch(tr);
    expect(shape(instance.state.doc)).toEqual(['p:Allein', 'p:Ende']);
  });

  it('refuses a position that is no list item', () => {
    const instance = createEditor(LIST);
    const tr = instance.state.tr;
    expect(liftListItemOut(tr, instance.state.doc.child(0).nodeSize)).toBeNull();
    expect(tr.docChanged).toBe(false);
  });
});
