// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';

import { buildEditorExtensions } from '@exocortex/editor';

import { deleteBlockRange } from './block-target';

/**
 * Issue #285: deleting a block from the handle's menu put the caret back where
 * it had been before the menu opened and scrolled there, so a heading deleted
 * in the middle of a long page sent the reader to the top.
 */

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function createEditor(content: string): Editor {
  editor = new Editor({ extensions: buildEditorExtensions({}), content });
  return editor;
}

/** Where the top-level block with this text starts. */
function blockAt(doc: PmNode, text: string): { from: number; to: number } {
  let range: { from: number; to: number } | null = null;
  doc.forEach((node, offset) => {
    if (node.textContent === text) range = { from: offset, to: offset + node.nodeSize };
  });
  if (range === null) throw new Error(`no block "${text}"`);
  return range;
}

describe('deleteBlockRange (issue #285)', () => {
  it('leaves the caret where the deleted block stood, not where it was before', () => {
    const instance = createEditor(
      '<p>Oben</p><p>Davor</p><h2>Überschrift</h2><p>Danach</p><p>Unten</p>',
    );
    // The caret the menu found: far away from the block, at the top.
    instance.commands.setTextSelection(1);

    deleteBlockRange(instance, blockAt(instance.state.doc, 'Überschrift'));

    const texts: string[] = [];
    instance.state.doc.forEach((node) => texts.push(node.textContent));
    expect(texts).toEqual(['Oben', 'Davor', 'Danach', 'Unten']);
    const { selection } = instance.state;
    expect(selection).toBeInstanceOf(TextSelection);
    expect(selection.empty).toBe(true);
    expect(selection.$from.parent.textContent).toBe('Danach');
    expect(selection.$from.parentOffset).toBe(0);
  });

  it('puts the caret at the end of the block before when the last block goes', () => {
    const instance = createEditor('<p>Erster</p><p>Letzter</p>');
    instance.commands.setTextSelection(1);

    deleteBlockRange(instance, blockAt(instance.state.doc, 'Letzter'));

    const { selection } = instance.state;
    expect(selection.$from.parent.textContent).toBe('Erster');
    expect(selection.$from.parentOffset).toBe('Erster'.length);
  });
});
