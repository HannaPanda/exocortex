import { describe, expect, it } from 'vitest';

import { doclingLayoutSchema, locateDoclingPages } from './docling-pages';

/**
 * A small `DoclingDocument` of the shape docling-serve 1.29 answers with:
 * a heading, a paragraph that runs from page 1 onto page 2 (one item, two
 * provenances), a page footer that the Markdown leaves out, a table opening
 * page 3 and a paragraph on page 4 with an underscore the Markdown escapes.
 */
const layout = doclingLayoutSchema.parse({
  body: {
    children: [
      { $ref: '#/texts/0' },
      { $ref: '#/texts/1' },
      { $ref: '#/texts/2' },
      { $ref: '#/tables/0' },
      { $ref: '#/groups/0' },
    ],
  },
  texts: [
    {
      label: 'section_header',
      content_layer: 'body',
      text: 'Einleitung zum Bericht',
      prov: [{ page_no: 1, charspan: [0, 22] }],
    },
    {
      label: 'text',
      content_layer: 'body',
      text: 'Der erste Absatz endet nicht auf Seite eins, sondern läuft weiter bis auf die zweite Seite hinüber.',
      prov: [
        { page_no: 1, charspan: [0, 44] },
        { page_no: 2, charspan: [44, 99] },
      ],
    },
    {
      label: 'page_footer',
      content_layer: 'furniture',
      text: 'sondern läuft weiter bis auf die zweite Seite',
      prov: [{ page_no: 1, charspan: [0, 10] }],
    },
    {
      label: 'list_item',
      content_layer: 'body',
      text: 'Eintrag mit einem Wert_in_der_Mitte und mehr Text danach',
      prov: [{ page_no: 4, charspan: [0, 56] }],
    },
  ],
  tables: [
    {
      label: 'table',
      content_layer: 'body',
      prov: [{ page_no: 3, charspan: [0, 0] }],
      data: { table_cells: [{ text: '' }, { text: 'Spalte Alpha' }] },
    },
  ],
  groups: [{ label: 'list', content_layer: 'body', children: [{ $ref: '#/texts/3' }] }],
  pictures: [],
  pages: { '1': {}, '2': {}, '3': {}, '4': {}, '5': {} },
});

const markdown = [
  '## Einleitung zum Bericht',
  '',
  'Der erste Absatz endet nicht auf Seite eins, sondern läuft weiter bis auf die zweite Seite hinüber.',
  '',
  '|    | Spalte Alpha |',
  '|----|--------------|',
  '| 1  | 2            |',
  '',
  '- Eintrag mit einem Wert\\_in\\_der\\_Mitte und mehr Text danach',
].join('\n');

describe('locateDoclingPages (ADR-101)', () => {
  it('places each page at its first share of text, inside an item where a paragraph runs on', () => {
    const starts = locateDoclingPages(markdown, layout);
    expect(starts).toHaveLength(5);
    expect(starts?.[0]).toBe(0);
    expect(markdown.slice(starts?.[1])).toMatch(/^sondern läuft weiter/);
    // A table is found by its first cell with text, and begins at its line.
    expect(markdown.slice(starts?.[2])).toMatch(/^\| {4}\| Spalte Alpha/);
    // An item's own start takes its Markdown prefix with it, and an escaped underscore is found.
    expect(markdown.slice(starts?.[3])).toMatch(/^- Eintrag mit/);
    // A page with nothing on it is not placed rather than guessed.
    expect(starts?.[4]).toBe(-1);
  });

  it('does not place a page at an earlier repetition of its text', () => {
    // The furniture item repeats page 2's words before the paragraph; it is
    // left out, and the paragraph is found after the heading, in order.
    const starts = locateDoclingPages(markdown, layout);
    expect(starts?.[1]).toBeGreaterThan(markdown.indexOf('Der erste Absatz'));
  });

  it('knows nothing without pages', () => {
    expect(locateDoclingPages(markdown, doclingLayoutSchema.parse({ pages: null }))).toBeNull();
  });
});
