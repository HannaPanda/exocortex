// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE, createBlockId, isValidBlockId } from './block-id';
import { type ProseMirrorDocument } from './contract';
import { buildEditorExtensions } from './extensions';
import { collectBlockIds, findDuplicateBlockIds } from './plain-text';

let editor: Editor | null = null;

function createEditor(content?: string | ProseMirrorDocument): Editor {
  editor = new Editor({
    extensions: buildEditorExtensions(),
    content: content ?? '<p>Erster Absatz</p>',
  });
  return editor;
}

function documentOf(instance: Editor): ProseMirrorDocument {
  return instance.getJSON() as unknown as ProseMirrorDocument;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('createBlockId', () => {
  it('creates valid, unique identifiers', () => {
    const ids = new Set(Array.from({ length: 500 }, () => createBlockId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(isValidBlockId(id)).toBe(true);
  });

  it('rejects malformed identifiers', () => {
    expect(isValidBlockId('')).toBe(false);
    expect(isValidBlockId('short')).toBe(false);
    expect(isValidBlockId('WITH-UPPERCASE')).toBe(false);
    expect(isValidBlockId(42)).toBe(false);
  });
});

describe('BlockId extension', () => {
  it('assigns an identifier to blocks created by editing', () => {
    const instance = createEditor();
    instance.commands.setContent('<p>Erster Absatz</p><h2>Eine Überschrift</h2>');
    const ids = collectBlockIds(documentOf(instance));
    expect(ids.length).toBeGreaterThanOrEqual(2);
    for (const id of ids) expect(isValidBlockId(id)).toBe(true);
  });

  it('preserves identifiers while editing other blocks', () => {
    const instance = createEditor('<p>Absatz eins</p><p>Absatz zwei</p>');
    instance.commands.setContent('<p>Absatz eins</p><p>Absatz zwei</p>');
    const before = documentOf(instance);
    const firstId = before.content?.[0]?.attrs?.[BLOCK_ID_ATTRIBUTE];
    expect(isValidBlockId(firstId)).toBe(true);

    instance.commands.focus('end');
    instance.commands.insertContent(' und noch etwas Text');

    const after = documentOf(instance);
    expect(after.content?.[0]?.attrs?.[BLOCK_ID_ATTRIBUTE]).toBe(firstId);
  });

  it('gives a split paragraph a fresh identifier instead of duplicating one', () => {
    const instance = createEditor('<p>AB</p>');
    instance.commands.setContent('<p>AB</p>');
    const originalId = documentOf(instance).content?.[0]?.attrs?.[BLOCK_ID_ATTRIBUTE];

    instance.commands.setTextSelection(2);
    instance.commands.splitBlock();

    const document = documentOf(instance);
    expect(document.content).toHaveLength(2);
    const ids = collectBlockIds(document);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(originalId);
  });

  it('repairs duplicated identifiers', () => {
    const duplicated: ProseMirrorDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { [BLOCK_ID_ATTRIBUTE]: 'duplicateid1' },
          content: [{ type: 'text', text: 'eins' }],
        },
        {
          type: 'paragraph',
          attrs: { [BLOCK_ID_ATTRIBUTE]: 'duplicateid1' },
          content: [{ type: 'text', text: 'zwei' }],
        },
      ],
    };
    const instance = createEditor();
    instance.commands.setContent(duplicated as unknown as Record<string, unknown>);
    // A document change triggers the repair pass.
    instance.commands.focus('end');
    instance.commands.insertContent('!');

    const document = documentOf(instance);
    expect(findDuplicateBlockIds(document)).toEqual([]);
  });

  it('keeps identifiers stable across an HTML round trip', () => {
    const instance = createEditor('<p>Mit Id</p>');
    instance.commands.setContent('<p>Mit Id</p>');
    const id = documentOf(instance).content?.[0]?.attrs?.[BLOCK_ID_ATTRIBUTE];
    const html = instance.getHTML();
    expect(html).toContain(`data-block-id="${String(id)}"`);

    instance.commands.setContent(html);
    expect(documentOf(instance).content?.[0]?.attrs?.[BLOCK_ID_ATTRIBUTE]).toBe(id);
  });
});
