import { describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { plainTextBlockMap, plainTextHeadingAnchors, serializePlainText } from './plain-text';

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

function item(text: string, blockId: string, ...nested: ProseMirrorNode[]): ProseMirrorNode {
  return {
    type: 'listItem',
    attrs: { [BLOCK_ID_ATTRIBUTE]: blockId },
    content: [paragraph(text), ...nested],
  };
}

function bulletList(blockId: string, ...items: ProseMirrorNode[]): ProseMirrorNode {
  return { type: 'bulletList', attrs: { [BLOCK_ID_ATTRIBUTE]: blockId }, content: items };
}

function idParagraph(text: string, blockId: string): ProseMirrorNode {
  return { ...paragraph(text), attrs: { [BLOCK_ID_ATTRIBUTE]: blockId } };
}

/** The unit a hit at the first occurrence of `word` is attributed to. */
function unitAt(page: ProseMirrorDocument, word: string, from = 0) {
  const map = plainTextBlockMap(page);
  const offset = map.text.indexOf(word, from);
  expect(offset).toBeGreaterThanOrEqual(0);
  const unit = [...map.units].reverse().find((entry) => entry.offset <= offset);
  return {
    blockId: unit?.blockId ?? null,
    section: unit === undefined || unit.heading < 0 ? null : map.headings[unit.heading],
  };
}

describe('plainTextBlockMap', () => {
  it('indexes exactly the text the page is indexed as', () => {
    const page = document(
      paragraph('Erster Absatz.   '),
      paragraph('  '),
      heading(2, 'Liste', 'listehead01'),
      bulletList('liste000001', item('Apfel', 'punktapfel1'), item('Birne', 'punktbirne1')),
    );

    expect(plainTextBlockMap(page).text).toBe(serializePlainText(page));
  });

  it('names the point of the second list a word stands in, not the first list', () => {
    const page = document(
      heading(2, 'Erste Liste', 'erstehead01'),
      bulletList('ersteliste1', item('Apfel', 'punktapfel1'), item('Birne', 'punktbirne1')),
      heading(2, 'Zweite Liste', 'zweitehead1'),
      bulletList('zweiteliste', item('Kirsche', 'punktkirsch'), item('Quitte', 'punktquitte')),
    );

    expect(unitAt(page, 'Quitte')).toEqual({
      blockId: 'punktquitte',
      section: { blockId: 'zweitehead1', path: ['Zweite Liste'] },
    });
    expect(unitAt(page, 'Apfel').blockId).toBe('punktapfel1');
  });

  it('names a nested point, and the outer point again after the nested list', () => {
    const page = document(
      bulletList('liste000001', {
        type: 'listItem',
        attrs: { [BLOCK_ID_ATTRIBUTE]: 'aussen00001' },
        content: [
          paragraph('Außen vorne'),
          bulletList('innen00list', item('Innen', 'innen000001')),
          paragraph('Außen hinten'),
        ],
      }),
    );

    expect(unitAt(page, 'vorne').blockId).toBe('aussen00001');
    expect(unitAt(page, 'Innen').blockId).toBe('innen000001');
    expect(unitAt(page, 'hinten').blockId).toBe('aussen00001');
  });

  it('falls back to the list when a point has no identifier of its own', () => {
    const page = document(
      bulletList('liste000001', {
        type: 'listItem',
        content: [paragraph('Ohne Kennung')],
      }),
    );

    expect(unitAt(page, 'Kennung').blockId).toBe('liste000001');
  });

  it('names top-level blocks and their section, and none before the first heading', () => {
    const page = document(
      idParagraph('Vorwort hier.', 'vorwort0001'),
      heading(1, 'Kapitel', 'kapitel0001'),
      heading(2, 'Abschnitt', 'abschnitt01'),
      idParagraph('Text im Abschnitt.', 'textabsch01'),
    );

    expect(unitAt(page, 'Vorwort')).toEqual({ blockId: 'vorwort0001', section: null });
    expect(unitAt(page, 'im Abschnitt')).toEqual({
      blockId: 'textabsch01',
      section: { blockId: 'abschnitt01', path: ['Kapitel', 'Abschnitt'] },
    });
    expect(unitAt(page, 'Abschnitt').blockId).toBe('abschnitt01');
  });

  it('keeps a container with text of its own as one unit', () => {
    const page = document({
      type: 'callout',
      attrs: { [BLOCK_ID_ATTRIBUTE]: 'hinweis0001', title: 'Achtung' },
      content: [bulletList('innenliste1', item('Darin', 'darin000001'))],
    });

    expect(unitAt(page, 'Darin').blockId).toBe('hinweis0001');
  });

  it('keeps the offsets right after the cleanups', () => {
    const page = document(
      idParagraph('Eins.   ', 'eins0000001'),
      paragraph('   '),
      paragraph('  '),
      bulletList('liste000001', item('Zwei   ', 'zwei0000001'), item('Drei', 'drei0000001')),
    );

    expect(unitAt(page, 'Drei').blockId).toBe('drei0000001');
    expect(unitAt(page, 'Zwei').blockId).toBe('zwei0000001');
    expect(unitAt(page, 'Eins').blockId).toBe('eins0000001');
  });
});
