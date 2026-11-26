// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
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

  it('puts a paragraph into an item or below the list, never between two items', () => {
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
    expect(candidates).toHaveLength(1);
    const $pos = doc.resolve(candidates[0]!.pos);
    expect($pos.parent.type.name).toBe('listItem');
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
