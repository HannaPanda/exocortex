import { describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { buildDocumentMap, extractBlockRange } from './document-map';
import { serializeMarkdown } from './markdown';

function heading(level: number, text: string, blockId: string): ProseMirrorNode {
  return {
    type: 'heading',
    attrs: { level, [BLOCK_ID_ATTRIBUTE]: blockId },
    content: [{ type: 'text', text }],
  };
}

function paragraph(text: string, blockId: string): ProseMirrorNode {
  return {
    type: 'paragraph',
    attrs: { [BLOCK_ID_ATTRIBUTE]: blockId },
    content: [{ type: 'text', text }],
  };
}

function item(text: string, blockId: string, ...nested: ProseMirrorNode[]): ProseMirrorNode {
  return {
    type: 'listItem',
    attrs: { [BLOCK_ID_ATTRIBUTE]: blockId },
    content: [paragraph(text, `${blockId}p`), ...nested],
  };
}

function list(
  type: 'bulletList' | 'orderedList',
  blockId: string,
  items: ProseMirrorNode[],
): ProseMirrorNode {
  return { type, attrs: { [BLOCK_ID_ATTRIBUTE]: blockId }, content: items };
}

function doc(...content: ProseMirrorNode[]): ProseMirrorDocument {
  return { type: 'doc', content };
}

/** `blocka0000`, `blocka0001`, … so a generated page has real addresses. */
function id(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(5, '0')}`;
}

describe('buildDocumentMap', () => {
  it('cuts a page at its shallowest heading level and sizes every section', () => {
    const map = buildDocumentMap(
      doc(
        heading(2, 'Erstens', 'headingaaa1'),
        paragraph('a'.repeat(100), 'parapara001'),
        heading(3, 'Darunter', 'headingaaa2'),
        paragraph('b'.repeat(100), 'parapara002'),
        heading(2, 'Zweitens', 'headingaaa3'),
        paragraph('c'.repeat(100), 'parapara003'),
      ),
    );

    expect(map.mode).toBe('sections');
    expect(map.entries).toHaveLength(2);
    expect(map.entries[0]).toMatchObject({
      kind: 'section',
      fromBlockId: 'headingaaa1',
      toBlockId: null,
      level: 2,
      title: 'Erstens',
      blocks: 4,
    });
    // The `###` under the first `##` is part of that section, not a sibling of
    // it: the page is cut at the level it is organized at.
    expect(map.entries[1]).toMatchObject({ title: 'Zweitens', blocks: 2 });
    expect(map.entries[0]?.chars).toBeGreaterThan(200);
  });

  it('names what sits before the first heading, because it is content too', () => {
    const map = buildDocumentMap(
      doc(paragraph('Vorspann', 'parapara001'), heading(2, 'Erstens', 'headingaaa1')),
    );

    expect(map.entries[0]).toMatchObject({
      kind: 'range',
      fromBlockId: 'parapara001',
      title: 'Vor der ersten Überschrift',
    });
  });

  it('falls back to block windows when a part has no headings at all', () => {
    // The floor of the recursion, and not a hypothetical: the largest page in
    // the real workspace holds 2.9 million characters behind 26 headings, so
    // its sections are flat runs of a hundred thousand characters each. A map
    // of headings would bottom out there with nothing to offer.
    const paragraphs = Array.from({ length: 200 }, (_, index) =>
      paragraph('x'.repeat(500), id('parapara', index)),
    );

    const map = buildDocumentMap(doc(...paragraphs), { maxEntries: 10 });

    expect(map.mode).toBe('ranges');
    expect(map.entries.length).toBeLessThanOrEqual(10);
    expect(map.entries[0]).toMatchObject({ kind: 'range', fromBlockId: 'parapara00000' });
    expect(map.entries[0]?.toBlockId).not.toBeNull();
    // Every block is covered exactly once, so nothing is unreachable.
    expect(map.entries.reduce((total, entry) => total + entry.blocks, 0)).toBe(200);
  });

  it('merges neighbouring sections rather than growing past the entry budget', () => {
    const sections = Array.from({ length: 120 }, (_, index) => [
      heading(2, `Abschnitt ${index}`, id('headingaa', index)),
      paragraph('x'.repeat(50), id('parapara', index)),
    ]).flat();

    const map = buildDocumentMap(doc(...sections), { maxEntries: 20 });

    expect(map.coarsened).toBe(true);
    expect(map.entries.length).toBeLessThanOrEqual(20);
    expect(map.entries[0]?.kind).toBe('range');
    expect(map.entries[0]?.title).toContain('Abschnitt 0');
    expect(map.entries.reduce((total, entry) => total + entry.blocks, 0)).toBe(240);
  });

  it('stays the same size for a page of three million characters', () => {
    // The promise the whole design rests on: what a map costs is decided by
    // the entry budget, never by the page.
    const blocks = Array.from({ length: 3_000 }, (_, index) =>
      paragraph('x'.repeat(1_000), id('parapara', index)),
    );

    const map = buildDocumentMap(doc(...blocks), { maxEntries: 40 });

    expect(map.totalChars).toBeGreaterThan(3_000_000);
    expect(map.entries.length).toBeLessThanOrEqual(40);
    expect(JSON.stringify(map).length).toBeLessThan(10_000);
  });

  it('never maps a fragment to itself, which would be a loop and not a step', () => {
    // Found on the real 2.9 million character page: reading its one section
    // handed back a fragment that opens with that same heading, and cutting at
    // the shallowest level present produced a single entry addressing the
    // heading again. The next read returned this same map, forever.
    const fragment = doc(
      heading(1, 'Higgsfield AI', 'headingaaa1'),
      paragraph('a'.repeat(200), 'parapara001'),
      heading(2, 'Teil eins', 'headingaaa2'),
      paragraph('b'.repeat(200), 'parapara002'),
      heading(2, 'Teil zwei', 'headingaaa3'),
      paragraph('c'.repeat(200), 'parapara003'),
    );

    const map = buildDocumentMap(fragment);

    expect(map.entries.length).toBeGreaterThan(1);
    const opening = map.entries[0] as { kind: string; fromBlockId: string; toBlockId: string };
    // The opening heading is named, but as the span it covers rather than as a
    // section: a section address would bring the whole fragment back.
    expect(opening).toMatchObject({
      kind: 'range',
      fromBlockId: 'headingaaa1',
      toBlockId: 'parapara001',
    });
    expect(map.entries[1]).toMatchObject({ kind: 'section', title: 'Teil eins' });

    // And the address resolves to less than the fragment, which is what makes
    // the recursion terminate.
    const opened = extractBlockRange(fragment, opening.fromBlockId, opening.toBlockId);
    expect(serializeMarkdown(opened as ProseMirrorDocument)).not.toContain('Teil eins');
  });

  it('gives a block that fills a window on its own an entry of its own', () => {
    // Also found on the real page: nine short paragraphs followed by a 2.8
    // million character code block came back as one window covering all ten,
    // whose map was that same window again.
    const items = [
      ...Array.from({ length: 9 }, (_, index) => paragraph('kurz', id('parapara', index))),
      paragraph('x'.repeat(200_000), 'riesigblock1'),
    ];

    const map = buildDocumentMap(doc(...items), { maxEntries: 20 });

    expect(map.mode).toBe('ranges');
    expect(map.entries).toHaveLength(2);
    expect(map.entries[0]?.blocks).toBe(9);
    expect(map.entries[1]).toMatchObject({
      fromBlockId: 'riesigblock1',
      toBlockId: 'riesigblock1',
      blocks: 1,
    });
  });

  it('reads a one-block range as that block, heading or not', () => {
    const page = doc(heading(2, 'Titel', 'headingaaa1'), paragraph('drin', 'parapara001'));

    const literal = extractBlockRange(page, 'headingaaa1', 'headingaaa1');
    const section = extractBlockRange(page, 'headingaaa1', null);

    expect(serializeMarkdown(literal as ProseMirrorDocument)).not.toContain('drin');
    expect(serializeMarkdown(section as ProseMirrorDocument)).toContain('drin');
  });

  it('carries no address for a part whose blocks have none', () => {
    const map = buildDocumentMap(
      doc({ type: 'paragraph', content: [{ type: 'text', text: 'ohne Kennung' }] }),
    );

    expect(map.entries[0]?.fromBlockId).toBeNull();
  });
});

describe('buildDocumentMap on long lists (issue #274)', () => {
  // Thirty short points, the shape Stefan's page had: twelve thousand
  // characters in total, no single point longer than a few hundred.
  const points = Array.from({ length: 30 }, (_, index) =>
    item(`Punkt ${index + 1}: ${'x'.repeat(300)}`, id('itemaaa', index)),
  );

  it('opens a list that fills the map into windows of its points', () => {
    const map = buildDocumentMap(doc(list('bulletList', 'listaaaaaaa1', points)), {
      maxEntries: 10,
    });

    expect(map.mode).toBe('ranges');
    expect(map.entries.length).toBeGreaterThan(1);
    // No entry is the list itself: each names its first and last point.
    for (const entry of map.entries) {
      expect(entry.fromBlockId).toMatch(/^itemaaa/);
      expect(entry.toBlockId).toMatch(/^itemaaa/);
      // Where it sits is data: the list is block 1, and these are its points.
      expect(entry.location).toMatchObject({ path: [1], points: true });
      expect(entry.title).toMatch(/^Punkt \d+:/);
    }
    // Consecutive windows, covering points 1 to 30 without a gap.
    expect(map.entries[0]?.location?.first).toBe(1);
    expect(map.entries.at(-1)?.location?.last).toBe(30);
    // Every point is covered exactly once, so none can go missing.
    expect(map.entries.reduce((total, entry) => total + entry.blocks, 0)).toBe(30);
  });

  it('reads every window back as points with their markers, and all of them', () => {
    const page = doc(list('bulletList', 'listaaaaaaa1', points));
    const map = buildDocumentMap(page, { maxEntries: 10 });

    const read = map.entries.map((entry) =>
      serializeMarkdown(
        extractBlockRange(
          page,
          entry.fromBlockId as string,
          entry.toBlockId,
        ) as ProseMirrorDocument,
      ),
    );

    for (const markdown of read) expect(markdown.startsWith('- Punkt')).toBe(true);
    const joined = read.join('');
    for (let index = 1; index <= 30; index += 1) expect(joined).toContain(`Punkt ${index}:`);
  });

  it('keeps windows inside one list when two lists and a paragraph share the page', () => {
    const page = doc(
      list('bulletList', 'listaaaaaaa1', points),
      paragraph('zwischen', 'parapara001'),
      list(
        'bulletList',
        'listaaaaaaa2',
        Array.from({ length: 40 }, (_, index) =>
          item(`Zweite ${index}: ${'y'.repeat(300)}`, id('itembbb', index)),
        ),
      ),
    );

    const map = buildDocumentMap(page, { maxEntries: 20 });

    // Both ends of a window are siblings, or it could not be read back.
    for (const entry of map.entries) {
      expect(extractBlockRange(page, entry.fromBlockId as string, entry.toBlockId)).not.toBeNull();
    }
    expect(map.entries.some((entry) => entry.location?.path[0] === 3)).toBe(true);
    expect(map.entries.some((entry) => entry.fromBlockId === 'parapara001')).toBe(true);
    expect(map.entries.reduce((total, entry) => total + entry.blocks, 0)).toBe(71);
  });

  it('opens a point that holds a long list of its own, one level down', () => {
    const nested = list(
      'bulletList',
      'listnested01',
      Array.from({ length: 20 }, (_, index) =>
        item(`Unterpunkt ${index}: ${'z'.repeat(300)}`, id('itemccc', index)),
      ),
    );
    const page = doc(
      list('bulletList', 'listaaaaaaa1', [
        item('kurz', 'itemaaa00000'),
        item('mit Unterliste', 'itemaaa00001', nested),
      ]),
    );

    const map = buildDocumentMap(page, { maxEntries: 10 });

    expect(map.entries.some((entry) => entry.fromBlockId?.startsWith('itemccc'))).toBe(true);
    // The second point is opened: its own blocks, and the points of its list.
    expect(
      map.entries.some(
        (entry) => entry.location?.points === false && entry.location.path.join() === '1,2',
      ),
    ).toBe(true);
    expect(
      map.entries.some(
        (entry) => entry.location?.points === true && entry.location.path.join() === '1,2,2',
      ),
    ).toBe(true);
  });

  it('counts on in a numbered list, so point 27 still reads "27."', () => {
    const page = doc(list('orderedList', 'listaaaaaaa1', points));

    const window = extractBlockRange(page, id('itemaaa', 26), id('itemaaa', 27));

    expect(serializeMarkdown(window as ProseMirrorDocument)).toMatch(/^27\. Punkt 27:/);
  });

  it('leaves a short list whole, where it changes nothing', () => {
    const page = doc(
      ...Array.from({ length: 40 }, (_, index) =>
        paragraph('x'.repeat(500), id('parapara', index)),
      ),
      list('bulletList', 'listaaaaaaa1', [
        item('eins', 'itemaaa00000'),
        item('zwei', 'itemaaa00001'),
      ]),
    );

    const map = buildDocumentMap(page, { maxEntries: 10 });

    expect(map.entries.some((entry) => entry.fromBlockId?.startsWith('itemaaa'))).toBe(false);
  });
});

describe('extractBlockRange', () => {
  const page = doc(
    paragraph('eins', 'parapara001'),
    paragraph('zwei', 'parapara002'),
    paragraph('drei', 'parapara003'),
  );

  it('reads a window of siblings, inclusive at both ends', () => {
    const fragment = extractBlockRange(page, 'parapara001', 'parapara002');

    expect(serializeMarkdown(fragment as ProseMirrorDocument)).toBe('eins\n\nzwei\n');
  });

  it('reads one block, section semantics included, when there is no end', () => {
    const sectioned = doc(
      heading(2, 'Titel', 'headingaaa1'),
      paragraph('drin', 'parapara001'),
      heading(2, 'Danach', 'headingaaa2'),
    );

    const fragment = extractBlockRange(sectioned, 'headingaaa1', null);

    expect(serializeMarkdown(fragment as ProseMirrorDocument)).toBe('## Titel\n\ndrin\n');
  });

  it('refuses an inverted range instead of quietly turning it around', () => {
    expect(extractBlockRange(page, 'parapara003', 'parapara001')).toBeNull();
  });

  it('is null when an end is gone, the way a dead reference is reported', () => {
    expect(extractBlockRange(page, 'parapara001', 'parapara999')).toBeNull();
  });
});
