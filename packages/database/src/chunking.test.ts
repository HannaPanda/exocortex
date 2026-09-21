import { describe, expect, it } from 'vitest';

import {
  CHUNK_THRESHOLD_CHARS,
  chunkBlockId,
  chunkPlainText,
  isChunkBlockId,
  MAX_CHUNKS_PER_DOCUMENT,
  type PassageAnchor,
} from './chunking';

/** A page of `count` blocks, each one recognisable by its number. */
function page(count: number, blockChars = 300): string {
  return Array.from({ length: count }, (_, index) =>
    `Absatz ${index} ${'wort '.repeat(Math.max(blockChars / 5, 1))}`.trim(),
  ).join('\n');
}

describe('chunkPlainText', () => {
  it('leaves a short page alone, because its one vector already says what it is about', () => {
    expect(chunkPlainText('Kurze Notiz über Termine.')).toEqual([]);
    expect(chunkPlainText('x'.repeat(CHUNK_THRESHOLD_CHARS))).toEqual([]);
  });

  it('cuts a long page into passages and numbers them from zero', () => {
    const chunks = chunkPlainText(page(40));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
  });

  it('keeps every block of the page in some passage', () => {
    const chunks = chunkPlainText(page(40));
    const joined = chunks.map((chunk) => chunk.text).join('\n');

    for (let index = 0; index < 40; index += 1) {
      expect(joined).toContain(`Absatz ${index} `);
    }
  });

  it('repeats the end of a passage at the start of the next one', () => {
    const chunks = chunkPlainText(page(40));
    const first = chunks[0];
    const second = chunks[1];
    if (first === undefined || second === undefined) throw new Error('expected two passages');

    const tail = second.text.split('\n')[0] ?? '';
    expect(tail.length).toBeGreaterThan(0);
    expect(first.text.endsWith(tail)).toBe(true);
  });

  it('never merges a remnant into a passage it would repeat twice', () => {
    for (const chunk of chunkPlainText(page(41))) {
      const blocks = chunk.text.split('\n');
      expect(new Set(blocks).size).toBe(blocks.length);
    }
  });

  it('appends a remnant too short to mean anything to the passage before it', () => {
    const text = ['a'.repeat(500), 'b'.repeat(500), 'c'.repeat(990), 'Schlusssatz.'].join('\n');
    const chunks = chunkPlainText(text, {
      targetChars: 1000,
      thresholdChars: 500,
      overlapChars: 0,
      minTailChars: 400,
    });
    const last = chunks[chunks.length - 1];
    if (last === undefined) throw new Error('expected a passage');

    expect(chunks).toHaveLength(3);
    expect(last.text).toBe(`${'c'.repeat(990)}\nSchlusssatz.`);
  });

  it('stops at the ceiling instead of giving one page a thousand vectors', () => {
    const chunks = chunkPlainText(page(4000));

    expect(chunks).toHaveLength(MAX_CHUNKS_PER_DOCUMENT);
  });

  it('cuts a single block that is longer than a whole passage', () => {
    const chunks = chunkPlainText(`${'wort '.repeat(2000)}`.trim());

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(2200);
    }
  });

  it('survives a block without a single space in it', () => {
    const chunks = chunkPlainText('x'.repeat(9000));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length > 0)).toBe(true);
  });
});

describe('chunkBlockId', () => {
  it('sorts in the order the passages were cut', () => {
    expect([chunkBlockId(10), chunkBlockId(2)].sort()).toEqual([chunkBlockId(2), chunkBlockId(10)]);
  });

  it('tells a passage row apart from a whole-document row', () => {
    expect(isChunkBlockId(chunkBlockId(0))).toBe(true);
    expect(isChunkBlockId(null)).toBe(false);
    expect(isChunkBlockId('block-abc')).toBe(false);
  });
});

describe('the heading a passage sits under', () => {
  /**
   * A page of two sections, each long enough to fill more than one passage,
   * with the headings where the plain-text projection would put them.
   */
  function sectioned(): { text: string; anchors: PassageAnchor[] } {
    const first = `Arzt-Checkliste\n${page(8)}`;
    const second = `Tumorambulanz\n${page(8)}`;
    return {
      text: `${first}\n${second}`,
      anchors: [
        { offset: 0, blockId: 'arztcheck01', path: ['Arzt-Checkliste'] },
        { offset: first.length + 1, blockId: 'tumorambu01', path: ['Tumorambulanz'] },
      ],
    };
  }

  it('gives each passage the last heading that begins at or before it', () => {
    const { text, anchors } = sectioned();

    const chunks = chunkPlainText(text, { anchors });

    // Where a passage *begins* decides, not what it happens to run into: a
    // passage that starts in the first section and reaches over the next
    // heading is still to be found in the first one.
    expect(chunks.length).toBeGreaterThan(2);
    const sections = chunks.map((chunk) => chunk.anchor?.blockId);
    const switched = sections.indexOf('tumorambu01');
    expect(switched).toBeGreaterThan(0);
    expect([...new Set(sections.slice(0, switched))]).toEqual(['arztcheck01']);
    expect([...new Set(sections.slice(switched))]).toEqual(['tumorambu01']);
  });

  it('says nothing when the caller handed no headings over', () => {
    const { text } = sectioned();

    expect(chunkPlainText(text).every((chunk) => chunk.anchor === null)).toBe(true);
  });

  it('leaves the text after the marker under no heading at all', () => {
    // What the search projection does with attachment text (issue #101): it
    // hangs behind the page and belongs to none of its sections.
    const pageText = `Arzt-Checkliste\n${page(6)}`;
    const text = `${pageText}\n\n${page(6)}`;
    const anchors: PassageAnchor[] = [
      { offset: 0, blockId: 'arztcheck01', path: ['Arzt-Checkliste'] },
      { offset: pageText.length, blockId: null, path: [] },
    ];

    const chunks = chunkPlainText(text, { anchors });

    expect(chunks[0]?.anchor?.blockId).toBe('arztcheck01');
    expect(chunks[chunks.length - 1]?.anchor).toBeNull();
  });
});
