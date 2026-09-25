import { describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { changedBlockIds } from './changed-blocks';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';

function paragraph(id: string, text: string): ProseMirrorNode {
  return {
    type: 'paragraph',
    attrs: { [BLOCK_ID_ATTRIBUTE]: id },
    content: [{ type: 'text', text }],
  };
}

function item(id: string, paragraphId: string, text: string): ProseMirrorNode {
  return {
    type: 'listItem',
    attrs: { [BLOCK_ID_ATTRIBUTE]: id },
    content: [paragraph(paragraphId, text)],
  };
}

function doc(...content: ProseMirrorNode[]): ProseMirrorDocument {
  return { type: 'doc', content };
}

const BEFORE = doc(
  paragraph('paraaaaaaaa1', 'Erster Absatz.'),
  {
    type: 'bulletList',
    attrs: { [BLOCK_ID_ATTRIBUTE]: 'listaaaaaaa1' },
    content: [
      item('itemaaaaaaa1', 'itemparaaaa1', 'Milch'),
      item('itemaaaaaaa2', 'itemparaaaa2', 'Brot'),
    ],
  },
  paragraph('paraaaaaaaa2', 'Letzter Absatz.'),
);

describe('changedBlockIds', () => {
  it('names nothing when the page is the same', () => {
    expect(changedBlockIds(BEFORE, structuredClone(BEFORE))).toEqual([]);
  });

  it('names a paragraph whose text changed', () => {
    const after = structuredClone(BEFORE);
    after.content![0] = paragraph('paraaaaaaaa1', 'Erster Absatz, korrigiert.');
    expect(changedBlockIds(BEFORE, after)).toEqual(['paraaaaaaaa1']);
  });

  it('names the innermost changed block inside a list, not the list', () => {
    const after = structuredClone(BEFORE);
    after.content![1]!.content![1] = item('itemaaaaaaa2', 'itemparaaaa2', 'Vollkornbrot');
    expect(changedBlockIds(BEFORE, after)).toEqual(['itemparaaaa2']);
  });

  it('names an inserted block and leaves its neighbours alone', () => {
    const after = doc(
      BEFORE.content![0]!,
      paragraph('paranewwwww1', 'Neu dazwischen.'),
      BEFORE.content![1]!,
      BEFORE.content![2]!,
    );
    expect(changedBlockIds(BEFORE, after)).toEqual(['paranewwwww1']);
  });

  it('names nothing for a deletion, because a removed block has no place to mark', () => {
    const after = doc(BEFORE.content![0]!, BEFORE.content![2]!);
    expect(changedBlockIds(BEFORE, after)).toEqual([]);
  });

  it('names a block whose own attributes changed', () => {
    const before = doc({
      type: 'heading',
      attrs: { level: 2, [BLOCK_ID_ATTRIBUTE]: 'headingaaaa1' },
      content: [{ type: 'text', text: 'Stand' }],
    });
    const after = doc({
      type: 'heading',
      attrs: { level: 3, [BLOCK_ID_ATTRIBUTE]: 'headingaaaa1' },
      content: [{ type: 'text', text: 'Stand' }],
    });
    expect(changedBlockIds(before, after)).toEqual(['headingaaaa1']);
  });

  it('stops at the limit', () => {
    const after = doc(
      paragraph('paranewwwww1', 'a'),
      paragraph('paranewwwww2', 'b'),
      paragraph('paranewwwww3', 'c'),
    );
    expect(changedBlockIds(BEFORE, after, 2)).toEqual(['paranewwwww1', 'paranewwwww2']);
  });
});
