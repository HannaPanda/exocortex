import { describe, expect, it } from 'vitest';

import { searchSettings } from './settings-search';

const docs = [
  { key: 'language', label: 'Sprache und Uhrzeit', keywords: ['sprache', 'uhrzeit'], options: [] },
  {
    key: 'overrides',
    label: 'Konfiguration',
    keywords: ['konfiguration', 'einstellungen'],
    options: ['Werkzeuge mit Jev auswählen', 'Systemprompt'],
  },
  { key: 'map', label: 'Aussehen der Wissenskarte', keywords: ['karte', 'sterne'], options: [] },
];

describe('searchSettings', () => {
  it('finds nothing while nothing is typed', () => {
    expect(searchSettings(docs, '  ')).toEqual([]);
  });

  it('finds a group by its name or its search words, word by word', () => {
    expect(searchSettings(docs, 'uhr spra').map((hit) => hit.doc.key)).toEqual(['language']);
    expect(searchSettings(docs, 'sterne').map((hit) => hit.doc.key)).toEqual(['map']);
  });

  it('names the option that answered when the group itself did not', () => {
    expect(searchSettings(docs, 'jev')).toEqual([
      { doc: docs[1], option: 'Werkzeuge mit Jev auswählen' },
    ]);
    expect(searchSettings(docs, 'konfig')[0]?.option).toBeNull();
  });

  it('names no option when the words are spread over several', () => {
    expect(searchSettings(docs, 'jev systemprompt')).toEqual([{ doc: docs[1], option: null }]);
  });
});
