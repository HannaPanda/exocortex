import { describe, expect, it } from 'vitest';

import { type CuratedDocumentIconName } from '@exocortex/contracts';

import { MAX_ICON_SEARCH_RESULTS, searchIconNames as searchWith } from './icon-search';
import { type LucideIconData } from './lucide-icon-store';

/**
 * The catalogue's names for the curated icons the cases below touch, in German,
 * the default locale. The component reads them through `useTranslations`.
 */
const LABELS: Partial<Record<CuratedDocumentIconName, string>> = {
  'circle-check': 'Haken',
  folder: 'Ordner',
  house: 'Haus',
};

function searchIconNames(query: string, data: LucideIconData | null): readonly string[] {
  // A curated icon the cases do not name gets no label at all, rather than its
  // English name, which would turn every English match into a curated one.
  return searchWith(query, data, (name) => LABELS[name] ?? '');
}

/**
 * A stand-in catalogue.
 *
 * The real one is generated and holds 1,756 names, which would make every
 * assertion here a statement about Lucide's releases rather than about the
 * ranking.
 */
function catalogue(names: string[], aliases: Record<string, string> = {}): LucideIconData {
  return { nodes: Object.fromEntries(names.map((name) => [name, []])), aliases };
}

describe('searchIconNames', () => {
  it('answers nothing before the catalogue has loaded', () => {
    expect(searchIconNames('haus', null)).toEqual([]);
  });

  it('answers nothing for an empty query', () => {
    expect(searchIconNames('   ', catalogue(['house']))).toEqual([]);
  });

  it('ranks the exact name, then the prefix, then the substring', () => {
    const data = catalogue(['pen', 'pen-line', 'open-book']);

    expect(searchIconNames('pen', data)).toEqual(['pen', 'pen-line', 'open-book']);
  });

  it('puts an alias hit behind every direct one', () => {
    const data = catalogue(['circle-check', 'check'], { 'check-circle': 'circle-check' });

    expect(searchIconNames('check', data)).toEqual(['check', 'circle-check']);
  });

  it('finds an English icon through its German word', () => {
    // Somebody typing "rakete" into a German field otherwise reads "we do not
    // have that icon" instead of "we have it, under another word".
    expect(searchIconNames('rakete', catalogue(['rocket', 'rabbit']))).toEqual(['rocket']);
  });

  it('accepts a prefix of the German word', () => {
    expect(searchIconNames('rake', catalogue(['rocket']))).toEqual(['rocket']);
  });

  it('follows a German word to all of its icons', () => {
    expect(searchIconNames('geld', catalogue(['banknote', 'coins', 'wallet', 'cat']))).toEqual([
      'coins',
      'wallet',
      'banknote',
    ]);
  });

  it('ranks a curated German label above any English name', () => {
    // `folder` carries a real German label; `folder-git-2` only carries the
    // English name, so "ordner" means the first one.
    expect(searchIconNames('ordner', catalogue(['folder-git-2', 'folder']))[0]).toBe('folder');
  });

  it('matches a curated label in the reader’s language', () => {
    const french = (name: CuratedDocumentIconName): string =>
      name === 'folder' ? 'Dossier' : name;

    expect(searchWith('dossier', catalogue(['folder', 'file']), french)).toEqual(['folder']);
  });

  it('sorts equal scores by length, then alphabetically', () => {
    const data = catalogue(['star-off', 'stars', 'star-half']);

    expect(searchIconNames('star', data)).toEqual(['stars', 'star-off', 'star-half']);
  });

  it('is case-insensitive', () => {
    expect(searchIconNames('  HAUS ', catalogue(['house']))).toEqual(['house']);
  });

  it('caps the grid rather than drawing the whole set', () => {
    const data = catalogue(Array.from({ length: 300 }, (_, index) => `a-${String(index)}`));

    expect(searchIconNames('a', data)).toHaveLength(MAX_ICON_SEARCH_RESULTS);
  });
});
