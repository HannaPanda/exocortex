// @vitest-environment jsdom
import { Editor, Extension } from '@tiptap/core';
import { history, undo } from '@tiptap/pm/history';
import { type Node as PmNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { buildEditorExtensions } from './extensions';
import {
  leadingNumberOf,
  type ListSortOrder,
  listSortOrders,
  sortableListAt,
  sortableListAtSelection,
  sortListTransaction,
} from './list-sort';

/** Issue #253: sorting one list on request, from the handle's menu. */

let editor: Editor | null = null;

/** The page's undo comes with Yjs; the plain history stands in for it here. */
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

function task(text: string, checked = false, inner = ''): string {
  return `<li data-type="taskItem" data-checked="${checked}"><p>${text}</p>${inner}</li>`;
}

function bullets(...texts: string[]): string {
  return `<ul>${texts.map((text) => `<li><p>${text}</p></li>`).join('')}</ul>`;
}

/** Where the first list of the page starts. */
function firstListPos(instance: Editor): number {
  let found = -1;
  instance.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (['bulletList', 'orderedList', 'taskList'].includes(node.type.name)) {
      found = pos;
      return false;
    }
    return true;
  });
  expect(found).toBeGreaterThanOrEqual(0);
  return found;
}

function sort(instance: Editor, order: ListSortOrder, pos = firstListPos(instance)): boolean {
  const tr = sortListTransaction(instance.state, pos, order, 'de');
  if (tr === null) return false;
  instance.view.dispatch(tr);
  return true;
}

/** Every text block in document order. */
function texts(instance: Editor): string[] {
  const out: string[] = [];
  instance.state.doc.descendants((node) => {
    if (node.isTextblock) out.push(node.textContent);
    return true;
  });
  return out;
}

function caretIn(instance: Editor, text: string, offset: number): void {
  let found = -1;
  instance.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isTextblock && node.textContent === text) {
      found = pos + 1 + offset;
      return false;
    }
    return true;
  });
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.create(instance.state.doc, found)),
  );
}

function blockIdOf(instance: Editor, text: string): unknown {
  let id: unknown = null;
  instance.state.doc.descendants((node: PmNode) => {
    if (id !== null) return false;
    if (node.type.name.endsWith('tem') && node.firstChild?.textContent === text) {
      id = node.attrs[BLOCK_ID_ATTRIBUTE];
      return false;
    }
    return true;
  });
  return id;
}

describe('sorting a list', () => {
  it('sorts alphabetically, ignoring case and accents and reading numbers as numbers', () => {
    const instance = createEditor(bullets('birne', 'Äpfel', 'Punkt 10', 'Punkt 9', 'apfel'));
    expect(sort(instance, 'alphabetical')).toBe(true);
    expect(texts(instance)).toEqual(['Äpfel', 'apfel', 'birne', 'Punkt 9', 'Punkt 10']);
  });

  it('sorts by the first number and puts items without one last, in their order', () => {
    const instance = createEditor(
      bullets('Kapitel 12', 'ohne Zahl', '2,5 kg', 'Version-3', '-4 °C', 'noch eine'),
    );
    expect(sort(instance, 'numeric')).toBe(true);
    expect(texts(instance)).toEqual([
      '-4 °C',
      '2,5 kg',
      'Version-3',
      'Kapitel 12',
      'ohne Zahl',
      'noch eine',
    ]);
  });

  it('puts done tasks below the open ones and keeps the order within both', () => {
    const instance = createEditor(
      `<ul data-type="taskList">${task('A', true)}${task('B')}${task('C', true)}${task('D')}</ul>`,
    );
    expect(sort(instance, 'checked')).toBe(true);
    expect(texts(instance)).toEqual(['B', 'D', 'A', 'C']);
    const ticks: unknown[] = [];
    instance.state.doc.descendants((node) => {
      if (node.type.name === 'taskItem') ticks.push(node.attrs.checked);
      return true;
    });
    expect(ticks).toEqual([false, false, true, true]);
  });

  it('moves every item with its sub-items and leaves the sub-list as it was', () => {
    const instance = createEditor(
      `<ul data-type="taskList">${task('Erledigt', true, `<ul data-type="taskList">${task('z offen')}${task('a fertig', true)}</ul>`)}${task('Offen')}</ul>`,
    );
    expect(sort(instance, 'checked')).toBe(true);
    expect(texts(instance)).toEqual(['Offen', 'Erledigt', 'z offen', 'a fertig']);
  });

  it('keeps the block ids, so a link to an item still finds it', () => {
    // HTML gets no ids until a transaction runs, so the fixture names them.
    const instance = createEditor(
      '<ul><li data-block-id="itembbbbbbbb"><p>B</p></li><li data-block-id="itemaaaaaaaa"><p>A</p></li></ul>',
    );
    expect(blockIdOf(instance, 'A')).toBe('itemaaaaaaaa');
    sort(instance, 'alphabetical');
    expect(texts(instance)).toEqual(['A', 'B']);
    expect(blockIdOf(instance, 'A')).toBe('itemaaaaaaaa');
    expect(blockIdOf(instance, 'B')).toBe('itembbbbbbbb');
  });

  it('is one step to undo', () => {
    const instance = createEditor(bullets('C', 'A', 'B'));
    sort(instance, 'alphabetical');
    expect(texts(instance)).toEqual(['A', 'B', 'C']);
    undo(instance.state, instance.view.dispatch);
    expect(texts(instance)).toEqual(['C', 'A', 'B']);
  });

  it('changes nothing and leaves no step when the list is already in order', () => {
    const instance = createEditor(bullets('A', 'B'));
    expect(sort(instance, 'alphabetical')).toBe(false);
  });

  it('carries the caret along with its item', () => {
    const instance = createEditor(bullets('Zebra', 'Affe'));
    caretIn(instance, 'Zebra', 3);
    sort(instance, 'alphabetical');
    expect(texts(instance)).toEqual(['Affe', 'Zebra']);
    expect(instance.state.selection.$from.parent.textContent).toBe('Zebra');
    expect(instance.state.selection.$from.parentOffset).toBe(3);
  });

  it('keeps a numbered list numbered from where it started', () => {
    const instance = createEditor('<ol start="3"><li><p>B</p></li><li><p>A</p></li></ol>');
    sort(instance, 'alphabetical');
    const list = instance.state.doc.firstChild;
    expect(list?.type.name).toBe('orderedList');
    expect(list?.attrs.start).toBe(3);
    expect(texts(instance)).toEqual(['A', 'B']);
  });
});

describe('which list and which orders', () => {
  it('offers "done to the bottom" for task lists only, and nothing for one item', () => {
    const tasks = createEditor(`<ul data-type="taskList">${task('A')}${task('B')}</ul>`);
    expect(listSortOrders(tasks.state.doc.child(0))).toEqual([
      'checked',
      'alphabetical',
      'numeric',
    ]);
    tasks.destroy();
    const plain = createEditor(`${bullets('A', 'B')}${bullets('Allein')}`);
    expect(listSortOrders(plain.state.doc.child(0))).toEqual(['alphabetical', 'numeric']);
    expect(listSortOrders(plain.state.doc.child(1))).toEqual([]);
    expect(sort(plain, 'checked')).toBe(false);
  });

  it('sorts the list an item stands in, the sub-list for a sub-item', () => {
    const instance = createEditor(
      '<ul><li><p>B</p><ul><li><p>B2</p></li><li><p>B1</p></li></ul></li><li><p>A</p></li></ul>',
    );
    const outer = firstListPos(instance);
    // The first item starts right inside the list.
    expect(sortableListAt(instance.state.doc, outer + 1)?.pos).toBe(outer);
    caretIn(instance, 'B2', 1);
    const inner = sortableListAtSelection(instance.state);
    expect(inner?.node.childCount).toBe(2);
    expect(inner?.pos).not.toBe(outer);
    sort(instance, 'alphabetical', inner?.pos);
    expect(texts(instance)).toEqual(['B', 'B1', 'B2', 'A']);
    expect(sortableListAt(instance.state.doc, 0)?.pos).toBe(0);
  });

  it('reads the first number of a text', () => {
    expect(leadingNumberOf('Kapitel 12')).toBe(12);
    expect(leadingNumberOf('2.5 kg')).toBe(2.5);
    expect(leadingNumberOf('-3 °C')).toBe(-3);
    expect(leadingNumberOf('Version-2')).toBe(2);
    expect(leadingNumberOf('keine')).toBeNull();
  });
});
