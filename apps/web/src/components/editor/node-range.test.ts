// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { isNodeRangeSelection, NodeRangeSelection } from '@tiptap/extension-node-range';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from '@exocortex/editor';

import { BlockNodeRange } from './node-range';

/**
 * Issue #251: the drag handle's node range bound `Shift+ArrowUp/Down` for
 * itself, so the first press turned any text selection into whole blocks.
 */

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function createEditor(): Editor {
  editor = new Editor({
    extensions: buildEditorExtensions({ additionalExtensions: [BlockNodeRange] }),
    content: '<p>Erster Absatz</p><p>Zweiter Absatz</p><p>Dritter Absatz</p>',
  });
  return editor;
}

function press(instance: Editor, key: 'ArrowUp' | 'ArrowDown'): boolean {
  const event = new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true });
  return (
    instance.view.someProp('handleKeyDown', (handler) => handler(instance.view, event)) ?? false
  );
}

describe('block node range (issue #251)', () => {
  it('leaves Shift+Arrow on a text selection to the browser', () => {
    const instance = createEditor();
    instance.view.dispatch(
      instance.state.tr.setSelection(TextSelection.create(instance.state.doc, 4, 4)),
    );

    expect(press(instance, 'ArrowDown')).toBe(false);
    expect(press(instance, 'ArrowUp')).toBe(false);
    expect(instance.state.selection).toBeInstanceOf(TextSelection);
    expect(instance.state.selection.anchor).toBe(4);
  });

  it('still grows a block range the handle made', () => {
    const instance = createEditor();
    const first = instance.state.doc.child(0).nodeSize;
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeRangeSelection.create(instance.state.doc, 1, 2)),
    );
    expect(instance.state.selection.to).toBe(first);

    expect(press(instance, 'ArrowDown')).toBe(true);
    expect(isNodeRangeSelection(instance.state.selection)).toBe(true);
    expect(instance.state.selection.to).toBe(first + instance.state.doc.child(1).nodeSize);
  });
});
