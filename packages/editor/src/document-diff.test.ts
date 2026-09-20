import { describe, expect, it } from 'vitest';

import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { applyBlocksFromDocument, diffDocuments, diffText } from './document-diff';

function paragraph(blockId: string, text: string): ProseMirrorNode {
  return { type: 'paragraph', attrs: { blockId }, content: [{ type: 'text', text }] };
}

function doc(...content: ProseMirrorNode[]): ProseMirrorDocument {
  return { type: 'doc', content };
}

const A = 'aaaaaaaaaaaa';
const B = 'bbbbbbbbbbbb';
const C = 'cccccccccccc';
const D = 'dddddddddddd';

describe('diffText', () => {
  it('keeps the untouched words as equal segments', () => {
    const segments = diffText('der Hund bellt laut', 'der Kater bellt laut');
    expect(segments.map((segment) => segment.kind)).toEqual([
      'equal',
      'removed',
      'inserted',
      'equal',
    ]);
    expect(segments.filter((segment) => segment.kind === 'removed')[0]?.text).toBe('Hund');
    expect(segments.filter((segment) => segment.kind === 'inserted')[0]?.text).toBe('Kater');
  });

  it('reassembles the old text from everything that is not an insertion', () => {
    const before = 'eins zwei drei vier fünf';
    const after = 'eins drei vier sechs fünf';
    const segments = diffText(before, after);
    const rebuiltBefore = segments
      .filter((segment) => segment.kind !== 'inserted')
      .map((segment) => segment.text)
      .join('');
    const rebuiltAfter = segments
      .filter((segment) => segment.kind !== 'removed')
      .map((segment) => segment.text)
      .join('');
    expect(rebuiltBefore).toBe(before);
    expect(rebuiltAfter).toBe(after);
  });

  it('returns one equal segment for identical text', () => {
    expect(diffText('gleich', 'gleich')).toEqual([{ kind: 'equal', text: 'gleich' }]);
  });
});

describe('diffDocuments', () => {
  it('reports an added, a removed and a changed block', () => {
    const before = doc(paragraph(A, 'bleibt'), paragraph(B, 'wird geändert'), paragraph(C, 'geht'));
    const after = doc(paragraph(A, 'bleibt'), paragraph(B, 'wurde geändert'), paragraph(D, 'neu'));

    const diff = diffDocuments(before, after);

    expect(diff.summary).toMatchObject({ added: 1, removed: 1, changed: 1, unchanged: 1 });
    const byId = new Map(diff.blocks.map((block) => [block.blockId, block]));
    expect(byId.get(A)?.kind).toBe('unchanged');
    expect(byId.get(B)?.kind).toBe('changed');
    expect(byId.get(C)?.kind).toBe('removed');
    expect(byId.get(D)?.kind).toBe('added');
  });

  it('reports a moved block as moved rather than as a deletion plus an insertion', () => {
    const before = doc(paragraph(A, 'eins'), paragraph(B, 'zwei'), paragraph(C, 'drei'));
    const after = doc(paragraph(C, 'drei'), paragraph(A, 'eins'), paragraph(B, 'zwei'));

    const diff = diffDocuments(before, after);

    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
    expect(diff.summary.changed).toBe(0);
    expect(diff.summary.moved).toBe(1);
    expect(diff.blocks.find((block) => block.blockId === C)?.moved).toBe(true);
  });

  it('shows a removed block where it used to stand', () => {
    const before = doc(paragraph(A, 'eins'), paragraph(B, 'zwei'), paragraph(C, 'drei'));
    const after = doc(paragraph(A, 'eins'), paragraph(C, 'drei'));

    const diff = diffDocuments(before, after);

    expect(diff.blocks.map((block) => block.blockId)).toEqual([A, B, C]);
    expect(diff.blocks[1]?.kind).toBe('removed');
  });

  it('keeps the text of unchanged blocks short', () => {
    const long = 'wort '.repeat(200).trim();
    const diff = diffDocuments(doc(paragraph(A, long)), doc(paragraph(A, long)), {
      maxUnchangedTextLength: 20,
    });
    expect(diff.blocks[0]?.afterText?.length).toBeLessThanOrEqual(21);
  });

  it('pairs identical blocks that carry no identifier', () => {
    const before = doc(
      { type: 'paragraph', content: [{ type: 'text', text: 'ohne Kennung' }] },
      paragraph(A, 'mit Kennung'),
    );
    const after = doc(
      { type: 'paragraph', content: [{ type: 'text', text: 'ohne Kennung' }] },
      paragraph(A, 'mit Kennung geändert'),
    );

    const diff = diffDocuments(before, after);

    expect(diff.summary).toMatchObject({ added: 0, removed: 0, changed: 1, unchanged: 1 });
    expect(diff.blocks[0]?.blockId).toBeNull();
    expect(diff.blocks[0]?.kind).toBe('unchanged');
  });

  it('notices a change that leaves the text alone', () => {
    const before = doc({
      type: 'paragraph',
      attrs: { blockId: A },
      content: [{ type: 'text', text: 'Link' }],
    });
    const after = doc({
      type: 'paragraph',
      attrs: { blockId: A },
      content: [
        {
          type: 'text',
          text: 'Link',
          marks: [{ type: 'link', attrs: { href: 'https://x.test' } }],
        },
      ],
    });

    expect(diffDocuments(before, after).blocks[0]?.kind).toBe('changed');
  });

  it('cuts the list off at the configured maximum', () => {
    const blocks = Array.from({ length: 12 }, (_, index) =>
      paragraph(`block${String(index).padStart(7, '0')}`, `Zeile ${index}`),
    );
    const diff = diffDocuments(doc(...blocks), doc(...blocks), { maxBlocks: 5 });
    expect(diff.blocks).toHaveLength(5);
    expect(diff.truncated).toBe(true);
  });
});

describe('applyBlocksFromDocument', () => {
  it('replaces a changed block with its older version', () => {
    const older = doc(paragraph(A, 'alt'), paragraph(B, 'bleibt'));
    const current = doc(paragraph(A, 'neu'), paragraph(B, 'bleibt'));

    const result = applyBlocksFromDocument(current, older, [A]);

    expect(result.restored).toEqual([A]);
    expect(result.document.content?.[0]).toEqual(paragraph(A, 'alt'));
    expect(result.document.content?.[1]).toEqual(paragraph(B, 'bleibt'));
  });

  it('puts a deleted block back next to the neighbour it had', () => {
    const older = doc(paragraph(A, 'eins'), paragraph(B, 'zwei'), paragraph(C, 'drei'));
    const current = doc(paragraph(A, 'eins'), paragraph(C, 'drei'));

    const result = applyBlocksFromDocument(current, older, [B]);

    expect(result.document.content?.map((node) => node.attrs?.blockId)).toEqual([A, B, C]);
  });

  it('puts a deleted first block back at the top', () => {
    const older = doc(paragraph(A, 'eins'), paragraph(B, 'zwei'));
    const current = doc(paragraph(B, 'zwei'));

    const result = applyBlocksFromDocument(current, older, [A]);

    expect(result.document.content?.map((node) => node.attrs?.blockId)).toEqual([A, B]);
  });

  it('takes a block out again when the older state never had it', () => {
    const older = doc(paragraph(A, 'eins'));
    const current = doc(paragraph(A, 'eins'), paragraph(B, 'dazugekommen'));

    const result = applyBlocksFromDocument(current, older, [B]);

    expect(result.removed).toEqual([B]);
    expect(result.document.content?.map((node) => node.attrs?.blockId)).toEqual([A]);
  });

  it('names identifiers neither state knows instead of failing', () => {
    const result = applyBlocksFromDocument(doc(paragraph(A, 'eins')), doc(paragraph(A, 'eins')), [
      D,
    ]);
    expect(result.missing).toEqual([D]);
    expect(result.restored).toEqual([]);
  });

  it('leaves an empty paragraph rather than a document without blocks', () => {
    const result = applyBlocksFromDocument(doc(paragraph(A, 'eins')), doc(), [A]);
    expect(result.document.content).toEqual([{ type: 'paragraph' }]);
  });

  it('restores several blocks in one pass', () => {
    const older = doc(paragraph(A, 'eins'), paragraph(B, 'zwei'), paragraph(C, 'drei'));
    const current = doc(paragraph(A, 'eins geändert'));

    const result = applyBlocksFromDocument(current, older, [A, B, C]);

    expect(result.document.content?.map((node) => node.attrs?.blockId)).toEqual([A, B, C]);
    expect(result.restored.sort()).toEqual([A, B, C].sort());
  });
});
