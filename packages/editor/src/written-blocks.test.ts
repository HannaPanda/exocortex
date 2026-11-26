import { describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { blockFingerprint, topLevelFingerprints, writtenTopLevelBlocks } from './written-blocks';

function paragraph(id: string, text: string, extra: Record<string, unknown> = {}): ProseMirrorNode {
  return {
    type: 'paragraph',
    attrs: { [BLOCK_ID_ATTRIBUTE]: id, ...extra },
    content: [{ type: 'text', text }],
  };
}

function doc(...content: ProseMirrorNode[]): ProseMirrorDocument {
  return { type: 'doc', content };
}

describe('writtenTopLevelBlocks', () => {
  const before = doc(
    paragraph('paraaaaaaaa1', 'Apfel'),
    paragraph('paraaaaaaaa2', 'Birne'),
    paragraph('paraaaaaaaa3', 'Pflaume'),
  );

  it('names a changed, an added and a removed block, and nothing else', () => {
    const after = doc(
      paragraph('paraaaaaaaa1', 'Apfel'),
      paragraph('paraaaaaaaa2', 'Kirsche'),
      paragraph('paraaaaaaaa4', 'Neu'),
    );
    const written = writtenTopLevelBlocks(before, after);
    expect(written.map((block) => block.id).sort()).toEqual([
      'paraaaaaaaa2',
      'paraaaaaaaa3',
      'paraaaaaaaa4',
    ]);
    expect(written.find((block) => block.id === 'paraaaaaaaa3')?.after).toBeNull();
    expect(written.find((block) => block.id === 'paraaaaaaaa2')?.after).toBe(
      topLevelFingerprints(after).get('paraaaaaaaa2'),
    );
  });

  it('groups a replaced block with its replacement, and separate places apart', () => {
    const after = doc(
      paragraph('newaaaaaaaa1', 'Äpfel'),
      paragraph('paraaaaaaaa2', 'Birne'),
      paragraph('newaaaaaaaa3', 'Zwetschge'),
    );
    const written = writtenTopLevelBlocks(before, after);
    const group = (id: string): number | undefined =>
      written.find((block) => block.id === id)?.group;
    expect(group('paraaaaaaaa1')).toBe(group('newaaaaaaaa1'));
    expect(group('paraaaaaaaa3')).toBe(group('newaaaaaaaa3'));
    expect(group('paraaaaaaaa1')).not.toBe(group('paraaaaaaaa3'));
  });

  it('does not count a block that only moved', () => {
    const after = doc(
      paragraph('paraaaaaaaa3', 'Pflaume'),
      paragraph('paraaaaaaaa1', 'Apfel'),
      paragraph('paraaaaaaaa2', 'Birne'),
    );
    expect(writtenTopLevelBlocks(before, after)).toEqual([]);
  });
});

describe('blockFingerprint', () => {
  it('ignores attribute order and attributes that are merely absent', () => {
    const left: ProseMirrorNode = {
      type: 'paragraph',
      attrs: { textAlign: null, [BLOCK_ID_ATTRIBUTE]: 'paraaaaaaaa1' },
      content: [{ type: 'text', text: 'Apfel' }],
    };
    const right: ProseMirrorNode = {
      content: [{ text: 'Apfel', type: 'text' }],
      attrs: { [BLOCK_ID_ATTRIBUTE]: 'paraaaaaaaa1' },
      type: 'paragraph',
    };
    expect(blockFingerprint(left)).toBe(blockFingerprint(right));
  });

  it('tells a different text or mark apart', () => {
    const plain = paragraph('paraaaaaaaa1', 'Apfel');
    const bold: ProseMirrorNode = {
      ...plain,
      content: [{ type: 'text', text: 'Apfel', marks: [{ type: 'bold' }] }],
    };
    expect(blockFingerprint(plain)).not.toBe(blockFingerprint(paragraph('paraaaaaaaa1', 'Äpfel')));
    expect(blockFingerprint(plain)).not.toBe(blockFingerprint(bold));
  });
});
