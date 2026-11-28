'use client';

import { useLocale } from 'next-intl';
import * as React from 'react';

import { DEFAULT_LOCALE, isLocale, type Locale } from '@exocortex/contracts';

/**
 * The emoji eXocortex offers: all of Unicode's, named in the reader's language.
 *
 * Shared by the editor's emoji menu and its `:` menu, which insert the character
 * as text, by the chat field's `:` menu, and by the page icon picker, which
 * stores it in `Document.icon`.
 *
 * The full set is 1,914 entries and about 170 kB of names per language, so it is
 * not in the first bundle, and a reader downloads only their own language.
 * `CURATED_EMOJI_GROUPS` below is in the first bundle: thirty emoji that cover
 * most picks, shown while the rest loads, so the picker is never an empty box.
 */
export interface EmojiEntry {
  readonly char: string;
  /** German name, used as the accessible label. */
  readonly label: string;
  /** Extra German words the search matches; the label is always matched too. */
  readonly keywords: readonly string[];
}

export interface EmojiGroup {
  /**
   * Set on the curated groups only: their heading is interface text, named in
   * the `editor.emojiMenu.groups` messages, while the dataset's groups bring
   * their headings in the reader's language already.
   */
  readonly curated?: 'frequent' | 'work' | 'people';
  readonly label: string;
  readonly emojis: readonly EmojiEntry[];
}

/** The shape `emoji-data/<locale>.generated.ts` carries: tuples, to save 60 kB of key names. */
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
    curated: 'frequent',
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
    curated: 'work',
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
    curated: 'people',
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

/** The emoji data of one interface language, each its own chunk. */
type EmojiDataModule = Promise<{ readonly EMOJI_DATA: EmojiData }>;

/**
 * One loader per interface language, written out rather than built from a
 * template string, so the bundler makes exactly these eight chunks and a locale
 * added to `SUPPORTED_LOCALES` without its file fails the typecheck here.
 */
const LOADERS: Readonly<Record<Locale, () => EmojiDataModule>> = {
  de: () => import('./emoji-data/de.generated'),
  en: () => import('./emoji-data/en.generated'),
  es: () => import('./emoji-data/es.generated'),
  fr: () => import('./emoji-data/fr.generated'),
  it: () => import('./emoji-data/it.generated'),
  nl: () => import('./emoji-data/nl.generated'),
  pl: () => import('./emoji-data/pl.generated'),
  'pt-BR': () => import('./emoji-data/pt-BR.generated'),
};

/**
 * One emoji whichever way it is spelled: the shortlist writes some without the
 * variation selector the dataset carries (`👍` and `👍️`), and the two must
 * be found as one, not listed twice.
 */
function emojiKey(char: string): string {
  return char.replace(/\uFE0F/gu, '');
}

const loaded = new Map<Locale, readonly EmojiGroup[]>();
const requests = new Map<Locale, Promise<readonly EmojiGroup[]>>();
const listeners = new Set<() => void>();

/**
 * The curated shortlist in the reader's language.
 *
 * Its hand-written names are German. In another language each entry takes its
 * name from the loaded set instead, and keeps the hand-written keywords beside
 * the dataset's, so "deploy" still finds the rocket.
 */
function curatedIn(byChar: ReadonlyMap<string, EmojiEntry>): readonly EmojiGroup[] {
  return CURATED_EMOJI_GROUPS.map((group) => ({
    ...group,
    emojis: group.emojis.map((entry) => {
      const named = byChar.get(emojiKey(entry.char));
      if (named === undefined) return entry;
      return {
        char: entry.char,
        label: named.label,
        keywords: [...new Set([...named.keywords, ...entry.keywords])],
      };
    }),
  }));
}

function toGroups(locale: Locale, data: EmojiData): readonly EmojiGroup[] {
  const groups: EmojiGroup[] = data.groups.map((group) => ({
    label: group.label,
    emojis: group.emojis.map(([char, label, keywords]) => ({ char, label, keywords })),
  }));
  if (locale === DEFAULT_LOCALE) return [...CURATED_EMOJI_GROUPS, ...groups];
  const byChar = new Map<string, EmojiEntry>();
  for (const group of groups) {
    for (const entry of group.emojis) byChar.set(emojiKey(entry.char), entry);
  }
  return [...curatedIn(byChar), ...groups];
}

/** Every emoji with its names in `locale`, fetched once per language. */
export function loadEmojiCatalog(locale: Locale): Promise<readonly EmojiGroup[]> {
  const ready = loaded.get(locale);
  if (ready !== undefined) return Promise.resolve(ready);
  let request = requests.get(locale);
  if (request === undefined) {
    request = LOADERS[locale]().then((module) => {
      const groups = toGroups(locale, module.EMOJI_DATA);
      loaded.set(locale, groups);
      for (const listener of listeners) listener();
      return groups;
    });
    requests.set(locale, request);
  }
  return request;
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function getServerSnapshot(): null {
  return null;
}

/**
 * Every emoji group in the reader's language, requesting the full set on first
 * use.
 *
 * Falls back to the curated groups until it arrives, so the picker opens filled
 * rather than empty and the common picks work in the first frame. `load: false`
 * holds the request back: the `:` menus are mounted with every editor and chat
 * field, and only the first typed shortcode should cost the download.
 */
export function useEmojiGroups({ load = true }: { load?: boolean } = {}): readonly EmojiGroup[] {
  const raw = useLocale();
  const locale: Locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  const getSnapshot = React.useCallback(() => loaded.get(locale) ?? null, [locale]);
  const groups = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  React.useEffect(() => {
    if (load) void loadEmojiCatalog(locale);
  }, [load, locale]);

  return groups ?? CURATED_EMOJI_GROUPS;
}

/**
 * How many hits the grid draws.
 *
 * "a" matches half the set; a popover is not the place to render a thousand
 * buttons, and nobody scrolls to the thousandth one.
 */
export const MAX_EMOJI_SEARCH_RESULTS = 120;

/**
 * How well one entry answers a query: lower is better, `null` is no match.
 *
 * A keyword spelled out in full ranks beside a name that starts with the query,
 * so `:tada` and `:herz` put their emoji first although neither is how CLDR
 * begins its name.
 */
function scoreOf(entry: EmojiEntry, needle: string): number | null {
  const label = entry.label.toLowerCase();
  if (label === needle) return 0;
  if (label.startsWith(needle) || entry.keywords.includes(needle)) return 1;
  if (label.includes(needle)) return 2;
  if (entry.keywords.some((keyword) => keyword.startsWith(needle))) return 3;
  if (entry.keywords.some((keyword) => keyword.includes(needle))) return 4;
  return null;
}

/**
 * The emoji matching the query, as one flat list.
 *
 * Flat and not grouped: with the full set loaded, a query like "herz" spreads
 * over five groups of two, and five headings above five icons is a worse answer
 * than one grid. Within one score the dataset's order holds, curated first.
 */
export function searchEmoji(
  query: string,
  groups: readonly EmojiGroup[],
  limit: number = MAX_EMOJI_SEARCH_RESULTS,
): readonly EmojiEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];

  const seen = new Set<string>();
  const scored: { entry: EmojiEntry; score: number }[] = [];
  for (const group of groups) {
    for (const entry of group.emojis) {
      const key = emojiKey(entry.char);
      if (seen.has(key)) continue;
      const score = scoreOf(entry, needle);
      if (score === null) continue;
      seen.add(key);
      scored.push({ entry, score });
    }
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((hit) => hit.entry);
}

/**
 * The emoji a complete shortcode names, for `:tada:` typed out to its closing
 * colon: its name or one of its keywords, spelled exactly. The first in the
 * dataset's order wins, which puts the curated shortlist first.
 */
export function exactEmoji(query: string, groups: readonly EmojiGroup[]): EmojiEntry | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return null;
  for (const group of groups) {
    for (const entry of group.emojis) {
      if (entry.label.toLowerCase() === needle || entry.keywords.includes(needle)) return entry;
    }
  }
  return null;
}
