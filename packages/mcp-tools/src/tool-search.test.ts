import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineTool } from './tool.js';
import { foldText, queryTerms, rankTools } from './tool-search.js';

/** The word search behind `exo_tool_search` (issue #265), on a few made-up tools. */

function tool(name: string, description: string) {
  return defineTool({
    name,
    description,
    inputSchema: z.object({}),
    surfaces: ['mcp'],
    domain: 'core',
    mutating: false,
    async execute() {
      return { text: name };
    },
  });
}

const tools = [
  tool('exo_page_set_layout', 'Setzt die Breite des Seitenkörpers.'),
  tool('exo_page_set_cover', 'Setzt das Titelbild einer Seite.'),
  tool('exo_entity_list', 'Listet die bekannten Entitäten.'),
  tool('exo_project_read_file', 'Liest eine Datei eines Projekts.'),
  tool('exo_project_list', 'Listet die Projekte.'),
];

const names = (query: string, extra?: Map<string, string>) =>
  rankTools({ tools, query, ...(extra === undefined ? {} : { searchText: extra }) }).map(
    (entry) => entry.tool.name,
  );

describe('tool search', () => {
  it('folds case, umlauts and their transliteration to one spelling', () => {
    expect(foldText('Entitäten')).toBe(foldText('ENTITAETEN'));
    expect(foldText('Entitäten')).toBe(foldText('entitaten'));
  });

  it('drops function words and cuts endings', () => {
    expect(queryTerms('Zeig mir die Entitäten')).toEqual(['zeig', 'entitat']);
    expect(queryTerms('list entities')).toEqual(['list', 'entit']);
  });

  it('finds a word in either language through its stem', () => {
    expect(names('Entitäten')[0]).toBe('exo_entity_list');
    expect(names('entities')[0]).toBe('exo_entity_list');
  });

  it('takes a compound apart into words the tools use', () => {
    // Neither "Seitenbreite" nor "Seitenkörperbreite" stands anywhere.
    expect(names('Seitenkörperbreite')[0]).toBe('exo_page_set_layout');
    expect(names('Seitenbreite')[0]).toBe('exo_page_set_layout');
  });

  it('reads an English tool name in German', () => {
    expect(names('Datei im Projekt lesen')[0]).toBe('exo_project_read_file');
  });

  it('lets a word every tool carries decide less than a rare one', () => {
    expect(names('Seite Titelbild')[0]).toBe('exo_page_set_cover');
  });

  it('searches the words handed in per tool', () => {
    expect(names('Kontakte', new Map([['exo_entity_list', 'Personen und Kontakte']]))).toEqual([
      'exo_entity_list',
    ]);
  });

  it('answers nothing for a query of function words only', () => {
    expect(names('und die der')).toEqual([]);
  });
});
