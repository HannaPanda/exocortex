import { describe, expect, it } from 'vitest';

import {
  attachmentPageUnits,
  buildAttachmentTextMap,
  keptPageStarts,
  readAttachmentText,
} from './attachment-text-map';

/** A text of `pages` pages of `chars` characters each, with the page starts that describe it. */
function pagedText(pages: number, chars: number): { text: string; starts: number[] } {
  const parts: string[] = [];
  const starts: number[] = [];
  let offset = 0;
  for (let page = 1; page <= pages; page += 1) {
    const body = `Seite ${page} beginnt hier.\n\n${'wort '.repeat(Math.ceil(chars / 5))}`.slice(
      0,
      chars,
    );
    starts.push(offset);
    parts.push(body);
    offset += body.length;
  }
  return { text: parts.join(''), starts };
}

describe('attachmentPageUnits', () => {
  it('joins a page whose start is unknown to the page before it', () => {
    expect(attachmentPageUnits([0, 100, -1, 300], 400)).toEqual([
      { fromPage: 1, toPage: 1, fromChar: 0, toChar: 100 },
      { fromPage: 2, toPage: 3, fromChar: 100, toChar: 300 },
      { fromPage: 4, toPage: 4, fromChar: 300, toChar: 400 },
    ]);
  });

  it('treats a start that runs backwards or past the end like an unknown one', () => {
    expect(attachmentPageUnits([0, 200, 150, 500], 400)).toEqual([
      { fromPage: 1, toPage: 1, fromChar: 0, toChar: 200 },
      { fromPage: 2, toPage: 4, fromChar: 200, toChar: 400 },
    ]);
  });

  it('knows no pages when none are stored', () => {
    expect(attachmentPageUnits([], 400)).toEqual([]);
  });
});

describe('keptPageStarts', () => {
  it('keeps the pages that begin inside a cut text', () => {
    expect(keptPageStarts([0, 100, -1, 300, 500], 400)).toEqual([0, 100, -1, 300]);
    expect(keptPageStarts(null, 400)).toEqual([]);
  });
});

describe('readAttachmentText', () => {
  it('answers the whole text when no budget is named', () => {
    const { text, starts } = pagedText(5, 4_000);
    const read = readAttachmentText(text, starts, {});
    expect(read).toMatchObject({ ok: true, view: 'content', text });
  });

  it('answers a text under the budget with the text', () => {
    const read = readAttachmentText('kurz', [], { maxChars: 10_000 });
    expect(read).toMatchObject({ ok: true, view: 'content', text: 'kurz', map: null });
  });

  it('answers a long text with its pages and never with its beginning', () => {
    const { text, starts } = pagedText(12, 4_000);
    const read = readAttachmentText(text, starts, { maxChars: 10_000 });
    if (!read.ok) throw new Error(read.reason);
    expect(read.view).toBe('map');
    expect(read.text).toBe('');
    expect(read.map?.mode).toBe('pages');
    expect(read.map?.entries).toHaveLength(12);
    expect(read.map?.entries[2]).toMatchObject({
      kind: 'pages',
      title: 'Seite 3 beginnt hier.',
      fromPage: 3,
      toPage: 3,
      fromChar: 8_000,
      toChar: 12_000,
      chars: 4_000,
    });
  });

  it('reads a page range as content and says which pages it covers', () => {
    const { text, starts } = pagedText(12, 4_000);
    const read = readAttachmentText(text, starts, { maxChars: 10_000, fromPage: 11, toPage: 12 });
    if (!read.ok) throw new Error(read.reason);
    expect(read.view).toBe('content');
    expect(read.text).toBe(text.slice(40_000));
    expect(read.range).toEqual({ fromChar: 40_000, toChar: 48_000, fromPage: 11, toPage: 12 });
  });

  it('maps a page range that is still too long by its pages', () => {
    const { text, starts } = pagedText(12, 4_000);
    const read = readAttachmentText(text, starts, { maxChars: 10_000, fromPage: 4, toPage: 9 });
    if (!read.ok) throw new Error(read.reason);
    expect(read.view).toBe('map');
    expect(read.map?.entries.map((entry) => entry.fromPage)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('merges neighbours instead of growing past the entry limit, and opens them finer', () => {
    const { text, starts } = pagedText(100, 500);
    const read = readAttachmentText(text, starts, { maxChars: 2_000, maxEntries: 10 });
    if (!read.ok) throw new Error(read.reason);
    expect(read.map?.coarsened).toBe(true);
    expect(read.map?.entries).toHaveLength(10);
    expect(read.map?.entries[1]).toMatchObject({ fromPage: 11, toPage: 20, parts: 10 });
    const finer = readAttachmentText(text, starts, {
      maxChars: 2_000,
      maxEntries: 10,
      fromPage: 11,
      toPage: 20,
    });
    if (!finer.ok) throw new Error(finer.reason);
    expect(finer.map?.entries.map((entry) => entry.fromPage)).toEqual([
      11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    ]);
  });

  it('maps one long page by its headings', () => {
    const page =
      `# Titel\n\nVorwort.\n\n## Erster Teil\n\n${'a '.repeat(3_000)}\n\n` +
      `## Zweiter Teil\n\n${'b '.repeat(3_000)}\n`;
    const read = readAttachmentText(page, [0], { maxChars: 4_000 });
    if (!read.ok) throw new Error(read.reason);
    expect(read.map?.mode).toBe('sections');
    // The page's own H1 does not divide it, so the cut is one level deeper.
    expect(read.map?.entries.map((entry) => [entry.level, entry.title])).toEqual([
      [1, 'Titel'],
      [2, 'Erster Teil'],
      [2, 'Zweiter Teil'],
    ]);
    expect(read.map?.entries[1]?.fromPage).toBe(1);
  });

  it('does not take a comment in fenced code for a heading', () => {
    const text = `Einleitung\n\n\`\`\`\n# kein Titel\n${'x '.repeat(3_000)}\n\`\`\`\n\n${'y '.repeat(3_000)}`;
    const map = buildAttachmentTextMap(
      text,
      [],
      { fromChar: 0, toChar: text.length, fromPage: null, toPage: null },
      { maxChars: 4_000, maxEntries: 40 },
    );
    expect(map.mode).toBe('windows');
  });

  it('falls back to paragraph windows that each fit the budget, and reaches every character', () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, index) => `Absatz ${index}. ${'z '.repeat(400)}`,
    );
    const text = paragraphs.join('\n\n');
    const read = readAttachmentText(text, [], { maxChars: 3_000 });
    if (!read.ok) throw new Error(read.reason);
    expect(read.map?.mode).toBe('windows');
    const entries = read.map?.entries ?? [];
    expect(entries[0]?.fromChar).toBe(0);
    expect(entries.at(-1)?.toChar).toBe(text.length);
    for (const [index, entry] of entries.entries()) {
      expect(entry.chars).toBeLessThanOrEqual(3_000);
      if (index > 0) expect(entry.fromChar).toBe(entries[index - 1]?.toChar);
      expect(entry.title).toMatch(/^Absatz \d+\./);
    }
  });

  it('cuts one enormous paragraph at spaces, still within the budget', () => {
    const text = 'wort '.repeat(10_000);
    const read = readAttachmentText(text, [], { maxChars: 4_000 });
    if (!read.ok) throw new Error(read.reason);
    for (const entry of read.map?.entries ?? []) {
      expect(entry.chars).toBeLessThanOrEqual(4_000);
      expect(text[entry.toChar - 1] === ' ' || entry.toChar === text.length).toBe(true);
    }
  });

  it('never splits a character made of two code units', () => {
    const text = `${'a'.repeat(9)}😀${'b'.repeat(9)}`;
    const read = readAttachmentText(text, [], { fromChar: 10, toChar: 15 });
    if (!read.ok) throw new Error(read.reason);
    expect(read.range.fromChar).toBe(9);
    expect(read.text.startsWith('😀')).toBe(true);
  });

  it('refuses pages of a text whose pages are unknown, and says how to read it instead', () => {
    const read = readAttachmentText('text', [], { fromPage: 2 });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toContain('fromChar');
  });

  it('refuses a page past the last and a mix of pages and characters', () => {
    const { text, starts } = pagedText(3, 100);
    expect(readAttachmentText(text, starts, { fromPage: 4 }).ok).toBe(false);
    expect(readAttachmentText(text, starts, { fromPage: 1, toChar: 5 }).ok).toBe(false);
    expect(readAttachmentText(text, starts, { fromChar: 50, toChar: 50 }).ok).toBe(false);
    // A last page past the end is the end, not an error.
    expect(readAttachmentText(text, starts, { fromPage: 2, toPage: 9 })).toMatchObject({
      ok: true,
      range: { fromPage: 2, toPage: 3 },
    });
  });
});
