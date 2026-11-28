import { describe, expect, it } from 'vitest';

import { codePointOffsets, toStoredBlockMap } from './search-block-map';

describe('codePointOffsets', () => {
  it('counts an emoji as one character, the way PostgreSQL does', () => {
    const text = 'Ein 😀 vor dem Wort';
    const offset = text.indexOf('Wort');

    // JavaScript sees the emoji as two units, PostgreSQL's strpos as one.
    expect(codePointOffsets(text, [0, offset])).toEqual([0, offset - 1]);
  });

  it('leaves text without surrogate pairs alone', () => {
    expect(codePointOffsets('Äpfel und Birnen', [0, 6, 10])).toEqual([0, 6, 10]);
  });
});

describe('toStoredBlockMap', () => {
  it('stores parallel arrays with short keys', () => {
    const stored = toStoredBlockMap({
      text: '😀 Kopf\nPunkt\n\nPDF-Text',
      units: [
        { offset: 0, blockId: 'kopf00000001', heading: 0, attachment: null },
        { offset: 8, blockId: 'punkt0000001', heading: 0, attachment: null },
        { offset: 15, blockId: 'pdfblock0001', heading: null, attachment: 0 },
      ],
      headings: [{ blockId: 'kopf00000001', path: ['😀 Kopf'] }],
      attachments: [{ attachmentId: 'att1', filename: 'Vertrag.pdf' }],
    });

    expect(stored).toEqual({
      o: [0, 7, 14],
      b: ['kopf00000001', 'punkt0000001', 'pdfblock0001'],
      s: [0, 0, null],
      a: [null, null, 0],
      h: [{ b: 'kopf00000001', p: ['😀 Kopf'] }],
      f: [{ id: 'att1', n: 'Vertrag.pdf' }],
    });
  });
});
