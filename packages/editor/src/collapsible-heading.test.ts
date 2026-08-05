import { describe, expect, it } from 'vitest';

import { collapsedDecorations, HEADING_COLLAPSED_ATTRIBUTE } from './collapsible-heading';
import { type ProseMirrorDocument } from './contract';
import { getExocortexSchema } from './schema';

/** Builds a document from a compact description, so the cases stay readable. */
function build(
  blocks: readonly (
    | { heading: number; collapsed?: boolean; text?: string }
    | { text: string }
  )[],
): ProseMirrorDocument {
  return {
    type: 'doc',
    content: blocks.map((block) =>
      'heading' in block
        ? {
            type: 'heading',
            attrs: {
              level: block.heading,
              [HEADING_COLLAPSED_ATTRIBUTE]: block.collapsed === true,
            },
            content: [{ type: 'text', text: block.text ?? `H${block.heading}` }],
          }
        : { type: 'paragraph', content: [{ type: 'text', text: block.text }] },
    ),
  };
}

/**
 * Texts of the top-level blocks the decoration set hides.
 *
 * Matches on the exact start position rather than on `find(from, to)`: adjacent
 * node decorations share a boundary, so an overlap query reports the neighbour too.
 */
function hiddenTexts(document: ProseMirrorDocument): string[] {
  const doc = getExocortexSchema().nodeFromJSON(document);
  const hiddenFrom = new Set(collapsedDecorations(doc).find().map((decoration) => decoration.from));

  const hidden: string[] = [];
  let offset = 0;
  doc.forEach((child) => {
    const from = offset;
    offset += child.nodeSize;
    if (hiddenFrom.has(from)) hidden.push(child.textContent);
  });
  return hidden;
}

describe('collapsible headings', () => {
  it('hides nothing while every heading is expanded', () => {
    const document = build([{ heading: 1 }, { text: 'Absatz' }, { heading: 2 }]);
    expect(hiddenTexts(document)).toEqual([]);
  });

  it('hides the blocks that follow a collapsed heading', () => {
    const document = build([
      { heading: 1, collapsed: true, text: 'Eingeklappt' },
      { text: 'versteckt 1' },
      { text: 'versteckt 2' },
    ]);
    expect(hiddenTexts(document)).toEqual(['versteckt 1', 'versteckt 2']);
  });

  it('stops at the next heading of the same level', () => {
    const document = build([
      { heading: 2, collapsed: true, text: 'A' },
      { text: 'versteckt' },
      { heading: 2, text: 'B' },
      { text: 'sichtbar' },
    ]);
    expect(hiddenTexts(document)).toEqual(['versteckt']);
  });

  it('stops at a heading of a higher level', () => {
    const document = build([
      { heading: 3, collapsed: true, text: 'A' },
      { text: 'versteckt' },
      { heading: 1, text: 'B' },
      { text: 'sichtbar' },
    ]);
    expect(hiddenTexts(document)).toEqual(['versteckt']);
  });

  it('swallows subsections, including their headings', () => {
    const document = build([
      { heading: 1, collapsed: true, text: 'A' },
      { text: 'versteckt 1' },
      { heading: 2, text: 'Unterabschnitt' },
      { text: 'versteckt 2' },
      { heading: 1, text: 'B' },
      { text: 'sichtbar' },
    ]);
    expect(hiddenTexts(document)).toEqual(['versteckt 1', 'Unterabschnitt', 'versteckt 2']);
  });

  it('keeps a nested collapsed heading collapsed after its parent reopens', () => {
    const document = build([
      { heading: 1, text: 'A' },
      { heading: 2, collapsed: true, text: 'Eingeklappt' },
      { text: 'versteckt' },
      { heading: 1, text: 'B' },
      { text: 'sichtbar' },
    ]);
    expect(hiddenTexts(document)).toEqual(['versteckt']);
  });

  it('leaves the collapsed heading itself visible', () => {
    const document = build([
      { heading: 1, collapsed: true, text: 'Eingeklappt' },
      { text: 'versteckt' },
    ]);
    expect(hiddenTexts(document)).not.toContain('Eingeklappt');
  });
});
