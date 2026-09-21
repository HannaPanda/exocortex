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
