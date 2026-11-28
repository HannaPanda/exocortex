import { describe, expect, it } from 'vitest';

import { type SearchResult } from '@exocortex/contracts';

import { placeOf, searchTool } from './search.js';

function hit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    documentId: 'doc1111111',
    workspaceId: 'ws11111111',
    title: 'Listen',
    icon: null,
    iconColor: null,
    type: 'PAGE',
    path: [],
    snippet: '<mark>Quitte</mark> pflücken',
    section: null,
    blockId: null,
    attachment: null,
    rank: 1,
    archivedAt: null,
    updatedAt: '2026-11-28T00:00:00.000Z',
    ...overrides,
  };
}

describe('exo_search', () => {
  it('names the list point and the section of a keyword hit (issue #280)', () => {
    const line = placeOf(
      hit({
        blockId: 'punktquitte1',
        section: { blockId: 'zweitehead1', path: ['Garten', 'Zweite Liste'] },
      }),
    );

    expect(line).toBe(', Abschnitt: Garten > Zweite Liste (^zweitehead1), Stelle: ^punktquitte1');
  });

  it('names the file for words out of an attachment, and the block that shows it', () => {
    expect(
      placeOf(
        hit({
          blockId: 'pdfblock0001',
          attachment: { attachmentId: 'att1', filename: 'Vertrag.pdf' },
        }),
      ),
    ).toBe(', im Anhang „Vertrag.pdf“ (attachmentId: att1, gezeigt von ^pdfblock0001)');
    expect(placeOf(hit({ attachment: { attachmentId: 'att1', filename: 'Vertrag.pdf' } }))).toBe(
      ', im Anhang „Vertrag.pdf“ (attachmentId: att1)',
    );
  });

  it('says nothing about a hit that is not located', () => {
    expect(placeOf(hit())).toBe('');
  });

  it('tells the caller how to read the place it names', () => {
    expect(searchTool.description).toContain('exo_page_block_read');
    expect(searchTool.description).toContain('Listenpunkt');
  });
});
