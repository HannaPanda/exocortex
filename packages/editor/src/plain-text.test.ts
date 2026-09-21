import { describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { plainTextHeadingAnchors, serializePlainText } from './plain-text';

function heading(level: number, text: string, blockId?: string): ProseMirrorNode {
  return {
    type: 'heading',
    attrs: { level, ...(blockId === undefined ? {} : { [BLOCK_ID_ATTRIBUTE]: blockId }) },
    content: [{ type: 'text', text }],
  };
}

function paragraph(text: string): ProseMirrorNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function document(...content: ProseMirrorNode[]): ProseMirrorDocument {
  return { type: 'doc', content };
}

describe('plainTextHeadingAnchors', () => {
  it('points at the heading it names, in the text the page is indexed as', () => {
    const page = document(
      paragraph('Eine Einleitung ohne Überschrift.'),
      heading(2, 'Arzt-Checkliste', 'arztcheck01'),
      paragraph('Blutdruck messen.'),
      heading(3, 'Tumorambulanz', 'tumorambu01'),
      paragraph('Termin im Oktober.'),
    );
    const text = serializePlainText(page);

    const anchors = plainTextHeadingAnchors(page);

    expect(anchors.map((anchor) => anchor.blockId)).toEqual(['arztcheck01', 'tumorambu01']);
    // The offset is the point of the whole thing: a passage found at some
    // position in this string has to be able to look up the heading above it.
    expect(anchors.map((anchor) => text.slice(anchor.offset, anchor.offset + 4))).toEqual([
      'Arzt',
      'Tumo',
    ]);
  });

  it('carries the headings a heading sits under, outermost first', () => {
    const anchors = plainTextHeadingAnchors(
      document(
        heading(1, 'Gesundheit'),
        heading(2, 'Aus dem Bot-Gedächtnis'),
        heading(3, 'Tumorambulanz'),
        heading(2, 'Wegovy-Start'),
      ),
    );

    expect(anchors.map((anchor) => anchor.path)).toEqual([
      ['Gesundheit'],
      ['Gesundheit', 'Aus dem Bot-Gedächtnis'],
      ['Gesundheit', 'Aus dem Bot-Gedächtnis', 'Tumorambulanz'],
      ['Gesundheit', 'Wegovy-Start'],
    ]);
  });

  it('survives the cleanups that shorten the text after the blocks are joined', () => {
    // Trailing blanks are stripped and runs of empty lines collapse, both
    // before the heading below. An offset taken before those edits would point
    // into the middle of the previous paragraph.
    const page = document(
      paragraph('Erster Absatz.   '),
      paragraph('   '),
      paragraph('  '),
      heading(2, 'Zweiter Teil', 'zweiterte01'),
      paragraph('Dahinter.'),
    );
    const text = serializePlainText(page);
    const [anchor] = plainTextHeadingAnchors(page);

    expect(anchor).toBeDefined();
    expect(text.startsWith('Zweiter Teil', anchor?.offset ?? -1)).toBe(true);
  });

  it('names a heading without an identifier rather than dropping it', () => {
    const [anchor] = plainTextHeadingAnchors(document(heading(2, 'Ohne Kennung')));

    expect(anchor).toMatchObject({ blockId: null, path: ['Ohne Kennung'] });
  });

  it('leaves a heading inside another block out, as the page map does', () => {
    const anchors = plainTextHeadingAnchors(
      document({
        type: 'toggle',
        content: [heading(2, 'Eingeklappt', 'eingeklap1'), paragraph('Inhalt.')],
      }),
    );

    expect(anchors).toEqual([]);
  });
});
