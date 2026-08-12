'use client';

import { DOCUMENT_ICON_KEYWORDS, DOCUMENT_ICON_LABELS } from './document-icon';
import { type LucideIconData } from './lucide-icon-store';

/**
 * German search words for icons that only have an English name.
 *
 * The curated icons carry a German label and German keywords, and the other
 * 1,700 carry Lucide's English name and nothing else. Somebody typing "rakete"
 * into a German search field would find nothing at all, which reads as "we do not
 * have that icon" rather than "we have it, under another word".
 *
 * So: one word to one or more Lucide name fragments. Not a translation of all
 * 1,756 names — that would be a dictionary nobody maintains. Just the words a
 * page icon is actually reached for by. A prefix of a key counts as the key, so
 * "rake" already finds the rocket.
 */
const ICON_SEARCH_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  abfall: ['trash'],
  aktie: ['trending-up', 'chart-candlestick'],
  akku: ['battery'],
  anker: ['anchor'],
  anruf: ['phone'],
  apfel: ['apple'],
  arzt: ['stethoscope', 'cross'],
  auge: ['eye'],
  auto: ['car'],
  ball: ['volleyball', 'football'],
  ballon: ['balloon'],
  banane: ['banana'],
  bank: ['landmark', 'banknote'],
  baum: ['tree'],
  becher: ['cup-soda'],
  berg: ['mountain'],
  bett: ['bed'],
  bier: ['beer'],
  bild: ['image'],
  bildschirm: ['monitor'],
  biene: ['bug'],
  blitz: ['zap'],
  blume: ['flower'],
  boot: ['sailboat', 'ship'],
  brief: ['mail'],
  brille: ['glasses'],
  brot: ['croissant', 'wheat'],
  brücke: ['bridge'],
  buch: ['book'],
  büro: ['building'],
  bus: ['bus'],
  chat: ['message-circle'],
  computer: ['computer', 'laptop'],
  daumen: ['thumbs-up'],
  diagramm: ['chart'],
  drucker: ['printer'],
  einkauf: ['shopping-cart', 'shopping-bag'],
  eis: ['ice-cream-cone', 'snowflake'],
  ei: ['egg'],
  erde: ['earth', 'globe'],
  fahrrad: ['bike'],
  farbe: ['palette', 'paintbrush'],
  feuer: ['flame'],
  film: ['film', 'clapperboard'],
  fisch: ['fish'],
  flasche: ['milk', 'wine'],
  flugzeug: ['plane'],
  foto: ['camera'],
  frage: ['circle-question-mark'],
  fußball: ['football'],
  gebäude: ['building'],
  geburtstag: ['cake', 'gift'],
  geld: ['banknote', 'coins', 'wallet'],
  geschenk: ['gift'],
  gehirn: ['brain'],
  gitarre: ['guitar'],
  glocke: ['bell'],
  hammer: ['hammer'],
  hand: ['hand'],
  handy: ['smartphone'],
  hase: ['rabbit'],
  haus: ['house'],
  herz: ['heart'],
  hund: ['dog'],
  hut: ['hard-hat', 'graduation-cap'],
  kaffee: ['coffee'],
  kalender: ['calendar'],
  kamera: ['camera'],
  karte: ['map', 'credit-card'],
  karotte: ['carrot'],
  katze: ['cat'],
  kerze: ['flame'],
  kette: ['link'],
  kind: ['baby'],
  kiste: ['box', 'package'],
  klemmbrett: ['clipboard'],
  knochen: ['bone'],
  koffer: ['briefcase', 'luggage'],
  kompass: ['compass'],
  kopf: ['user', 'brain'],
  kopfhörer: ['headphones'],
  krone: ['crown'],
  küche: ['cooking-pot', 'utensils'],
  kuchen: ['cake'],
  lampe: ['lamp', 'lightbulb'],
  laptop: ['laptop'],
  laufen: ['footprints'],
  leiter: ['ladder'],
  liste: ['list'],
  lupe: ['search'],
  maus: ['mouse'],
  medaille: ['medal'],
  messer: ['utensils-crossed'],
  mikrofon: ['mic'],
  mond: ['moon'],
  motorrad: ['bike'],
  müll: ['trash'],
  musik: ['music'],
  nachricht: ['message-circle', 'mail'],
  nadel: ['pin', 'syringe'],
  ordner: ['folder'],
  paket: ['package'],
  papier: ['file', 'scroll'],
  pause: ['pause', 'coffee'],
  pfeil: ['arrow-right'],
  pflanze: ['sprout', 'leaf'],
  pinsel: ['paintbrush'],
  pizza: ['pizza'],
  pokal: ['trophy'],
  rakete: ['rocket'],
  rechner: ['calculator'],
  regen: ['cloud-rain'],
  regenschirm: ['umbrella'],
  roboter: ['bot'],
  sanduhr: ['hourglass'],
  schere: ['scissors'],
  schiff: ['ship'],
  schlaf: ['moon', 'bed'],
  schloss: ['lock', 'castle'],
  schlüssel: ['key'],
  schmetterling: ['bug'],
  schnee: ['snowflake'],
  schraube: ['wrench', 'screwdriver'],
  schuh: ['footprints'],
  schule: ['school', 'graduation-cap'],
  segel: ['sailboat'],
  smiley: ['smile'],
  sonne: ['sun'],
  spiel: ['gamepad-2', 'dices'],
  sport: ['dumbbell'],
  sprache: ['languages', 'message-circle'],
  stern: ['star'],
  stift: ['pen', 'pencil'],
  stuhl: ['armchair'],
  tasche: ['briefcase', 'shopping-bag'],
  tasse: ['coffee', 'cup-soda'],
  telefon: ['phone'],
  tier: ['paw-print'],
  tisch: ['table'],
  tropfen: ['droplet'],
  uhr: ['clock', 'watch'],
  urlaub: ['palmtree', 'plane'],
  vogel: ['bird'],
  wolke: ['cloud'],
  warenkorb: ['shopping-cart'],
  wasser: ['droplet', 'waves'],
  wecker: ['alarm-clock'],
  welt: ['globe', 'earth'],
  werkzeug: ['wrench', 'hammer'],
  wetter: ['cloud-sun'],
  wein: ['wine'],
  zahn: ['smile'],
  zeit: ['clock'],
  zelt: ['tent'],
  zug: ['train-front'],
};

/**
 * How many hits the grid draws.
 *
 * A query like "a" matches most of the set, and 1,700 SVGs in a popover is a
 * frozen tab. Whoever is looking at result 121 is browsing, not searching, and
 * the "Alle Symbole" section is the place for that.
 */
export const MAX_ICON_SEARCH_RESULTS = 120;

/** Everything the query should be matched against, German words included. */
function termsFor(needle: string): readonly string[] {
  const terms = new Set([needle]);
  for (const [word, names] of Object.entries(ICON_SEARCH_SYNONYMS)) {
    if (!word.startsWith(needle)) continue;
    for (const name of names) terms.add(name);
  }
  return [...terms];
}

/**
 * Lower is better; `null` means no match.
 *
 * The order is the order a human expects: what they typed exactly, then what
 * begins with it, then what merely contains it.
 */
function scoreName(name: string, terms: readonly string[]): number | null {
  let best: number | null = null;
  for (const term of terms) {
    const score = name === term ? 0 : name.startsWith(term) ? 1 : name.includes(term) ? 2 : null;
    if (score !== null && (best === null || score < best)) best = score;
  }
  return best;
}

/**
 * Icon names matching the query, best first.
 *
 * German matches on the curated set rank above everything: those icons have a
 * real German name, so somebody typing "Ordner" means that one and not
 * `folder-git-2`.
 */
export function searchIconNames(query: string, data: LucideIconData | null): readonly string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0 || data === null) return [];

  const terms = termsFor(needle);
  const aliasesOf = new Map<string, string[]>();
  for (const [alias, canonical] of Object.entries(data.aliases)) {
    aliasesOf.set(canonical, [...(aliasesOf.get(canonical) ?? []), alias]);
  }

  const scored: { name: string; score: number }[] = [];
  for (const name of Object.keys(data.nodes)) {
    const german =
      (DOCUMENT_ICON_LABELS as Readonly<Record<string, string | undefined>>)[name]
        ?.toLowerCase()
        .includes(needle) === true ||
      ((DOCUMENT_ICON_KEYWORDS as Readonly<Record<string, readonly string[] | undefined>>)[name] ??
        []).some((keyword) => keyword.includes(needle));

    const direct = scoreName(name, terms);
    const viaAlias = (aliasesOf.get(name) ?? []).reduce<number | null>((best, alias) => {
      const score = scoreName(alias, terms);
      if (score === null) return best;
      // An alias hit is a hit at one remove, so it sorts behind the direct ones.
      return best === null || score + 3 < best ? score + 3 : best;
    }, null);

    const score = german ? -1 : direct !== null ? direct : viaAlias;
    if (score !== null) scored.push({ name, score });
  }

  scored.sort((a, b) => a.score - b.score || a.name.length - b.name.length || (a.name < b.name ? -1 : 1));
  return scored.slice(0, MAX_ICON_SEARCH_RESULTS).map((entry) => entry.name);
}
