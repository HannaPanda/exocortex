// @vitest-environment jsdom
import { Editor, Extension } from '@tiptap/core';
import { history, undo } from '@tiptap/pm/history';
import { type Node as PmNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';

import {
  blockDropCandidates,
  type BlockDropSource,
  blockDropTransaction,
  dropGap,
  dropLeafAt,
  dropWrapType,
} from './block-drop';
import { buildEditorExtensions } from './extensions';

/**
 * Issue #243: where a dragged block can land, and what landing does. The
 * measuring and drawing need a browser and are proven in
 * `e2e/tests/block-drag.spec.ts`; the document half is here.
 */

let editor: Editor | null = null;

/** The page's undo comes with Yjs; the plain history stands in for it here. */
const History = Extension.create({
  name: 'testHistory',
  addProseMirrorPlugins: () => [history()],
});

function createEditor(content: string): Editor {
  editor = new Editor({ extensions: buildEditorExtensions(), content });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** The text block whose text is exactly `text`. */
function textblock(doc: PmNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isTextblock && node.textContent === text) {
      found = pos;
      return false;
    }
    return true;
  });
  expect(found).toBeGreaterThanOrEqual(0);
  return found;
}

/** The list item whose own text is `text`. */
function item(doc: PmNode, text: string): BlockDropSource {
  const $pos = doc.resolve(textblock(doc, text));
  return { from: $pos.before(), to: $pos.after() };
}

/** The page as an outline: one line per text block, indented by list depth. */
function outline(doc: PmNode): string[] {
  const lines: string[] = [];
  const walk = (node: PmNode, level: number): void => {
    node.forEach((child) => {
      if (child.isTextblock) {
        lines.push(`${'  '.repeat(level)}${child.textContent}`);
        return;
      }
      const list = ['orderedList', 'bulletList', 'taskList'].includes(child.type.name);
      walk(child, level + (list ? 1 : 0));
    });
  };
  walk(doc, 0);
  return lines;
}

/** Drops the item `text` into the gap above or below the text block `at`. */
function dropItem(
  instance: Editor,
  text: string,
  at: string,
  side: 'above' | 'below',
  pick: (candidates: ReturnType<typeof blockDropCandidates>) => number,
): void {
  const { state } = instance;
  const source = item(state.doc, text);
  const content = state.doc.slice(source.from, source.to).content;
  const leaf = dropLeafAt(state.doc, textblock(state.doc, at) + 1, -1);
  expect(leaf).not.toBeNull();
  const gap = dropGap(state.doc, leaf ?? 0, side === 'below');
  const candidates = blockDropCandidates(
    state.doc,
    gap,
    content,
    source,
    dropWrapType(state.doc, source, content),
  );
  const candidate = candidates[pick(candidates)];
  expect(candidate).toBeDefined();
  if (candidate === undefined) return;
  const tr = blockDropTransaction(state, source, candidate, content, true);
  expect(tr).not.toBeNull();
  if (tr !== null) instance.view.dispatch(tr);
}

const LIST =
  '<p>Oben</p><ol><li><p>Eins</p></li><li><p>Zwei</p></li><li><p>Drei</p></li></ol><p>Unten</p>';

describe('block drop', () => {
  it('offers the list and a list of its own above the first item, and moves within the list', () => {
    const instance = createEditor(LIST);
    const { doc } = instance.state;
    const source = item(doc, 'Drei');
    const content = doc.slice(source.from, source.to).content;
    const gap = dropGap(doc, textblock(doc, 'Eins'), false);
    const candidates = blockDropCandidates(
      doc,
      gap,
      content,
      source,
      dropWrapType(doc, source, content),
    );
    // Below "Oben" at page level (a new list) and inside the list, first.
    expect(candidates.map((entry) => entry.wrap?.name ?? null)).toEqual(['orderedList', null]);

    dropItem(instance, 'Drei', 'Eins', 'above', (list) => list.findIndex((c) => c.wrap === null));
    expect(outline(instance.state.doc)).toEqual(['Oben', '  Drei', '  Eins', '  Zwei', 'Unten']);
    // Still one list: the numbers follow the order.
    let lists = 0;
    instance.state.doc.forEach((node) => {
      if (node.type.name === 'orderedList') lists += 1;
    });
    expect(lists).toBe(1);
  });

  it('nests an item under its neighbour as a sub-list of the same kind', () => {
    const instance = createEditor(LIST);
    dropItem(instance, 'Drei', 'Zwei', 'below', (list) => list.findIndex((c) => c.wrap !== null));
    expect(outline(instance.state.doc)).toEqual(['Oben', '  Eins', '  Zwei', '    Drei', 'Unten']);
    const zwei = instance.state.doc.resolve(textblock(instance.state.doc, 'Drei') + 1).node(-2);
    expect(zwei.type.name).toBe('orderedList');
  });

  it('lifts a sub-item out of its list and leaves no empty sub-list behind', () => {
    const instance = createEditor(
      '<ul><li><p>A</p><ul><li><p>A1</p></li></ul></li><li><p>B</p></li></ul><p>Ende</p>',
    );
    const { doc } = instance.state;
    const source = item(doc, 'A1');
    const content = doc.slice(source.from, source.to).content;
    const gap = dropGap(doc, textblock(doc, 'B'), true);
    const candidates = blockDropCandidates(
      doc,
      gap,
      content,
      source,
      dropWrapType(doc, source, content),
    );
    // Under B (a sub-list), after B in the list, and below the list.
    expect(candidates.map((entry) => entry.wrap?.name ?? null)).toEqual([
      'bulletList',
      null,
      'bulletList',
    ]);
    const tr = blockDropTransaction(instance.state, source, candidates[1]!, content, true);
    if (tr === null) throw new Error('no drop');
    instance.view.dispatch(tr);
    expect(outline(instance.state.doc)).toEqual(['  A', '  B', '  A1', 'Ende']);
    expect(instance.getHTML()).not.toContain('<ul></ul>');
    expect(instance.state.doc.child(0).child(0).childCount).toBe(1);
  });

  it('offers a paragraph the item above and the place between two items, never an item of its own', () => {
    const instance = createEditor(
      '<p>Absatz</p><ul><li><p>A</p></li><li><p>B</p></li></ul><p>Ende</p>',
    );
    const { doc } = instance.state;
    const paragraph = textblock(doc, 'Absatz');
    const source = { from: paragraph, to: paragraph + (doc.nodeAt(paragraph)?.nodeSize ?? 0) };
    const content = doc.slice(source.from, source.to).content;
    expect(dropWrapType(doc, source, content)).toBeNull();
    const gap = dropGap(doc, textblock(doc, 'A'), true);
    const candidates = blockDropCandidates(doc, gap, content, source, null);
    // Inside A (a second line of the item), and between A and B (a split).
    expect(candidates.map((entry) => entry.split === true)).toEqual([false, true]);
    expect(doc.resolve(candidates[0]!.pos).parent.type.name).toBe('listItem');
    expect(doc.resolve(candidates[1]!.pos).parent.type.name).toBe('bulletList');
  });

  it('splits the list where a paragraph lands between two items, in one undo step', () => {
    const instance = new Editor({
      extensions: [...buildEditorExtensions(), History],
      content:
        '<p>Absatz</p><ol><li><p>Eins</p><ul><li><p>Eins a</p></li></ul></li>' +
        '<li><p>Zwei</p></li><li><p>Drei</p></li></ol>',
    });
    editor = instance;
    const { state } = instance;
    const paragraph = textblock(state.doc, 'Absatz');
    const source = {
      from: paragraph,
      to: paragraph + (state.doc.nodeAt(paragraph)?.nodeSize ?? 0),
    };
    const content = state.doc.slice(source.from, source.to).content;
    // The gap above "Zwei": below "Eins a", the end of its sub-list and item.
    const gap = dropGap(state.doc, textblock(state.doc, 'Zwei'), false);
    const candidates = blockDropCandidates(state.doc, gap, content, source, null);
    const split = candidates.find((entry) => entry.split === true);
    expect(split).toBeDefined();
    const tr = blockDropTransaction(state, source, split!, content, true);
    if (tr === null) throw new Error('no drop');
    instance.view.dispatch(tr);
    // Two numbered lists with the paragraph between; the sub-item stayed.
    expect(outline(instance.state.doc)).toEqual([
      '  Eins',
      '    Eins a',
      'Absatz',
      '  Zwei',
      '  Drei',
    ]);
    const kinds: string[] = [];
    instance.state.doc.forEach((node) => kinds.push(node.type.name));
    expect(kinds).toEqual(['orderedList', 'paragraph', 'orderedList']);
    expect(instance.state.doc.child(2).attrs.start).toBe(1);

    undo(instance.state, instance.view.dispatch);
    expect(outline(instance.state.doc)).toEqual([
      'Absatz',
      '  Eins',
      '    Eins a',
      '  Zwei',
      '  Drei',
    ]);
  });

  it('splits a sub-list when a paragraph lands between two sub-items', () => {
    const instance = createEditor(
      '<ul><li><p>A</p><ul><li><p>A1</p></li><li><p>A2</p></li></ul></li></ul><p>Absatz</p>',
    );
    const { state } = instance;
    const paragraph = textblock(state.doc, 'Absatz');
    const source = {
      from: paragraph,
      to: paragraph + (state.doc.nodeAt(paragraph)?.nodeSize ?? 0),
    };
    const content = state.doc.slice(source.from, source.to).content;
    const gap = dropGap(state.doc, textblock(state.doc, 'A1'), true);
    const split = blockDropCandidates(state.doc, gap, content, source, null).find(
      (entry) => entry.split === true,
    );
    if (split === undefined) throw new Error('no split offered');
    const tr = blockDropTransaction(state, source, split, content, true);
    if (tr === null) throw new Error('no drop');
    instance.view.dispatch(tr);
    // The paragraph now stands inside A, between the two halves of its sub-list.
    expect(outline(instance.state.doc)).toEqual(['  A', '    A1', '  Absatz', '    A2']);
  });

  it('splits a task list for an item of another kind of list', () => {
    const instance = createEditor(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>T1</p></li>' +
        '<li data-type="taskItem" data-checked="false"><p>T2</p></li></ul><ul><li><p>Punkt</p></li></ul>',
    );
    const { state } = instance;
    const source = item(state.doc, 'Punkt');
    const content = state.doc.slice(source.from, source.to).content;
    const gap = dropGap(state.doc, textblock(state.doc, 'T1'), true);
    const split = blockDropCandidates(
      state.doc,
      gap,
      content,
      source,
      dropWrapType(state.doc, source, content),
    ).find((entry) => entry.split === true);
    if (split === undefined) throw new Error('no split offered');
    expect(split.wrap?.name).toBe('bulletList');
    const tr = blockDropTransaction(state, source, split, content, true);
    if (tr === null) throw new Error('no drop');
    instance.view.dispatch(tr);
    const kinds: string[] = [];
    instance.state.doc.forEach((node) => kinds.push(node.type.name));
    expect(kinds).toEqual(['taskList', 'bulletList', 'taskList']);
  });

  it('keeps a task item a task item when it becomes a sub-item', () => {
    const instance = createEditor(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Eins</p></li>' +
        '<li data-type="taskItem" data-checked="true"><p>Zwei</p></li></ul>',
    );
    dropItem(instance, 'Zwei', 'Eins', 'below', (list) => list.findIndex((c) => c.wrap !== null));
    const $zwei = instance.state.doc.resolve(textblock(instance.state.doc, 'Zwei') + 1);
    expect($zwei.node(-1).type.name).toBe('taskItem');
    expect($zwei.node(-1).attrs.checked).toBe(true);
    expect($zwei.node(-2).type.name).toBe('taskList');
    expect($zwei.node(-3).type.name).toBe('taskItem');
  });

  it('never offers a place inside the dragged item', () => {
    const instance = createEditor('<ul><li><p>A</p><ul><li><p>A1</p></li></ul></li></ul>');
    const { doc } = instance.state;
    const source = item(doc, 'A');
    const content = doc.slice(source.from, source.to).content;
    const gap = dropGap(doc, textblock(doc, 'A'), true);
    const candidates = blockDropCandidates(
      doc,
      gap,
      content,
      source,
      dropWrapType(doc, source, content),
    );
    for (const candidate of candidates) {
      expect(candidate.pos <= source.from || candidate.pos >= source.to).toBe(true);
    }
  });

  it('does nothing when a block is dropped where it already is', () => {
    const instance = createEditor(LIST);
    const { state } = instance;
    const source = item(state.doc, 'Zwei');
    const content = state.doc.slice(source.from, source.to).content;
    expect(
      blockDropTransaction(state, source, { pos: source.to, wrap: null }, content, true),
    ).toBeNull();
  });

  it('treats a whole table as one block', () => {
    const instance = createEditor(
      '<p>Vor</p><table><tbody><tr><td><p>Zelle</p></td></tr></tbody></table><p>Nach</p>',
    );
    const { doc } = instance.state;
    const leaf = dropLeafAt(doc, textblock(doc, 'Zelle') + 1, -1);
    expect(leaf).not.toBeNull();
    expect(doc.nodeAt(leaf ?? 0)?.type.name).toBe('table');
  });
});
