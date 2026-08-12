'use client';

import * as React from 'react';

/**
 * The emoji eXocortex offers: all of Unicode's, with German names.
 *
 * Shared by the editor's emoji menu, which inserts the character as text, and by
 * the page icon picker, which stores it in `Document.icon`.
 *
 * The full set is 1,914 entries and 160 kB of German labels, so it is not in the
 * first bundle. `CURATED_EMOJI_GROUPS` below is: thirty emoji that cover most
 * picks, shown while the rest loads, so the picker is never an empty box.
 */
export interface EmojiEntry {
  readonly char: string;
  /** German name, used as the accessible label. */
  readonly label: string;
  /** Extra German words the search matches; the label is always matched too. */
  readonly keywords: readonly string[];
}

export interface EmojiGroup {
  readonly label: string;
  readonly emojis: readonly EmojiEntry[];
}

/** The shape `emoji-data.generated.ts` carries: tuples, to save 60 kB of key names. */
export interface EmojiData {
  readonly groups: readonly {
    readonly key: string;
    readonly label: string;
    readonly emojis: readonly [char: string, label: string, tags: string[]][];
  }[];
}

/**
 * The shortlist, kept by hand.
 *
 * Not a slice of the generated data: these are the emoji this product's pages get
 * marked with, in the order someone reaches for them, and that judgement is not
 * in any dataset. It stays first even once the full set has loaded.
 */
export const CURATED_EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    label: 'Häufig',
    emojis: [
      { char: '✅', label: 'Haken', keywords: ['fertig', 'check', 'ok'] },
      { char: '❌', label: 'Kreuz', keywords: ['fehler', 'nein', 'x'] },
      { char: '⚠️', label: 'Warnung', keywords: ['achtung', 'warning'] },
      { char: '💡', label: 'Idee', keywords: ['glühbirne', 'tipp'] },
      { char: '📌', label: 'Pinnadel', keywords: ['pin', 'wichtig', 'merken'] },
      { char: '🔥', label: 'Feuer', keywords: ['dringend', 'hot'] },
      { char: '🚀', label: 'Rakete', keywords: ['start', 'launch', 'deploy'] },
      { char: '🐛', label: 'Käfer', keywords: ['bug', 'fehler'] },
      { char: '🧠', label: 'Gehirn', keywords: ['brain', 'denken'] },
      { char: '⏱️', label: 'Stoppuhr', keywords: ['zeit', 'timer'] },
    ],
  },
  {
    label: 'Arbeit',
    emojis: [
      { char: '📝', label: 'Notiz', keywords: ['schreiben', 'notes'] },
      { char: '📄', label: 'Dokument', keywords: ['seite', 'datei'] },
      { char: '📁', label: 'Ordner', keywords: ['projekt', 'folder'] },
      { char: '📊', label: 'Diagramm', keywords: ['daten', 'chart'] },
      { char: '📅', label: 'Kalender', keywords: ['termin', 'datum'] },
      { char: '🔗', label: 'Link', keywords: ['verweis', 'kette'] },
      { char: '🔍', label: 'Suche', keywords: ['lupe', 'finden'] },
      { char: '🛠️', label: 'Werkzeug', keywords: ['tools', 'wartung'] },
      { char: '⚙️', label: 'Einstellung', keywords: ['zahnrad', 'config'] },
      { char: '🔒', label: 'Schloss', keywords: ['sicherheit', 'privat'] },
    ],
  },
  {
    label: 'Menschen',
    emojis: [
      { char: '👋', label: 'Winken', keywords: ['hallo', 'hi'] },
      { char: '👍', label: 'Daumen hoch', keywords: ['gut', 'ok', 'plus'] },
      { char: '👎', label: 'Daumen runter', keywords: ['schlecht'] },
      { char: '🙏', label: 'Danke', keywords: ['bitte', 'hände'] },
      { char: '🎉', label: 'Feier', keywords: ['party', 'erfolg'] },
      { char: '😀', label: 'Lachen', keywords: ['freude', 'smile'] },
      { char: '🤔', label: 'Nachdenken', keywords: ['hmm', 'frage'] },
      { char: '😅', label: 'Schwitzen', keywords: ['knapp', 'ups'] },
      { char: '❤️', label: 'Herz', keywords: ['liebe', 'love'] },
      { char: '☕', label: 'Kaffee', keywords: ['pause', 'coffee'] },
    ],
  },
];

let data: readonly EmojiGroup[] | null = null;
let request: Promise<readonly EmojiGroup[]> | null = null;
const listeners = new Set<() => void>();

function toGroups(loaded: EmojiData): readonly EmojiGroup[] {
  return [
    ...CURATED_EMOJI_GROUPS,
    ...loaded.groups.map((group) => ({
      label: group.label,
      emojis: group.emojis.map(([char, label, keywords]) => ({ char, label, keywords })),
    })),
  ];
}

export function loadEmojiCatalog(): Promise<readonly EmojiGroup[]> {
  if (data !== null) return Promise.resolve(data);
  request ??= import('./emoji-data.generated').then((module) => {
    data = toGroups(module.EMOJI_DATA);
    for (const listener of listeners) listener();
    return data;
  });
  return request;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getSnapshot(): readonly EmojiGroup[] | null {
  return data;
}

function getServerSnapshot(): null {
  return null;
}

/**
 * Every emoji group, requesting the full set on first use.
 *
 * Falls back to the curated groups until it arrives, so the picker opens filled
 * rather than empty and the common picks work in the first frame.
 */
export function useEmojiGroups(): readonly EmojiGroup[] {
  const loaded = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  React.useEffect(() => {
    void loadEmojiCatalog();
  }, []);

  return loaded ?? CURATED_EMOJI_GROUPS;
}

/**
 * How many hits the grid draws.
 *
 * "a" matches half the set; a popover is not the place to render a thousand
 * buttons, and nobody scrolls to the thousandth one.
 */
export const MAX_EMOJI_SEARCH_RESULTS = 120;

/**
 * The emoji matching the query, as one flat list.
 *
 * Flat and not grouped: with the full set loaded, a query like "herz" spreads
 * over five groups of two, and five headings above five icons is a worse answer
 * than one grid. The label matches first, then the keywords.
 */
export function searchEmoji(
  query: string,
  groups: readonly EmojiGroup[],
): readonly EmojiEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const seen = new Set<string>();
  const scored: { entry: EmojiEntry; score: number }[] = [];
  for (const group of groups) {
    for (const entry of group.emojis) {
      if (seen.has(entry.char)) continue;
      const label = entry.label.toLowerCase();
      const score = label === needle
        ? 0
        : label.startsWith(needle)
          ? 1
          : label.includes(needle)
            ? 2
            : entry.keywords.some((keyword) => keyword.startsWith(needle))
              ? 3
              : entry.keywords.some((keyword) => keyword.includes(needle))
                ? 4
                : null;
      if (score === null) continue;
      seen.add(entry.char);
      scored.push({ entry, score });
    }
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, MAX_EMOJI_SEARCH_RESULTS).map((hit) => hit.entry);
}
