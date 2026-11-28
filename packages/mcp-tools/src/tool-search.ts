import { domainKeywords, domainLabel } from './domains.js';
import { type AnyToolDefinition } from './tool.js';

/**
 * The word search behind `exo_tool_search` (issues #256, #265).
 *
 * Deliberately no embeddings: the tools are a fixed list of a few hundred
 * entries, the query is a handful of words a chat model typed, and the answer
 * has to be the same on every call. What a plain substring match missed in the
 * spike was German compounds: "Seitenbreite" found nothing, because the tool
 * says "Breite des Seitenkörpers". So a query word also counts as found when
 * the words of a tool's text cover it, part by part, and a word of the text
 * counts when it contains the query word. Both directions are a substring
 * test after folding case and diacritics, so "Entitäten", "entitaeten" and
 * "Entitaten" land on the same stem.
 *
 * The words searched are the tool's own name and description, the label and
 * switch-on keywords of its domain (`domains.ts`), and whatever the caller
 * hands in as `searchText` per tool. The API hands in the title and summary of
 * the feature entry that claims the tool, in every interface language, so the
 * words a person would use to ask for a capability find its tool without a
 * third list of synonyms to keep up (rule 15, ADR-040).
 */

/** Function words that would match half the catalogue and say nothing. Folded. */
const STOPWORDS = new Set([
  // German
  'aber',
  'alle',
  'auch',
  'auf',
  'aus',
  'bei',
  'bitte',
  'das',
  'dem',
  'den',
  'der',
  'des',
  'die',
  'dies',
  'diese',
  'dieser',
  'ein',
  'eine',
  'einem',
  'einen',
  'einer',
  'eines',
  'fur',
  'gib',
  'hat',
  'ich',
  'ihr',
  'im',
  'ist',
  'kann',
  'mal',
  'mein',
  'meine',
  'meinen',
  'meiner',
  'mich',
  'mir',
  'mit',
  'nach',
  'oder',
  'sie',
  'sind',
  'uber',
  'und',
  'uns',
  'von',
  'vom',
  'was',
  'welche',
  'wie',
  'wird',
  'zum',
  'zur',
  // English
  'all',
  'and',
  'are',
  'can',
  'for',
  'from',
  'give',
  'how',
  'into',
  'its',
  'me',
  'my',
  'of',
  'please',
  'show',
  'that',
  'the',
  'this',
  'to',
  'what',
  'which',
  'with',
  'you',
  'your',
  // Words every tool carries
  'exo',
  'exocortex',
  'tool',
  'tools',
  'werkzeug',
  'werkzeuge',
]);

/** Lowercase, without diacritics: "Entitäten" and "Entitaten" are one word. */
export function foldText(text: string): string {
  return (
    text
      .toLowerCase()
      .replaceAll('ß', 'ss')
      .replaceAll('ä', 'ae')
      .replaceAll('ö', 'oe')
      .replaceAll('ü', 'ue')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      // The transliteration and the plain vowel are both in use ("Entitaeten"
      // and "Entitäten" read the same to a person); one spelling for both.
      .replaceAll(/([aou])e/gu, '$1')
  );
}

function wordsOf(folded: string): string[] {
  return folded.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

/** Endings cut off a word, longest first, as long as four letters remain. */
const SUFFIXES = ['ungen', 'ieren', 'ies', 'ing', 'ung', 'en', 'er', 'es', 'e', 's', 'n'];

/**
 * A crude stem. German and English both inflect at the end ("Entitäten",
 * "Seiten", "entities", "layouts"), and the stem is only ever used as a
 * substring, so "entit" finds "entity" as well as "entities". A stem shorter
 * than four letters would find everything, so nothing is cut below that.
 */
function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/**
 * German for the words tool names are made of.
 *
 * The names are English and the descriptions German, so "Datei im Projekt
 * lesen" met `exo_project_read_file` in neither: the name says "read file",
 * the description "liest". This is not a synonym list per tool but the small
 * vocabulary the names are built from, glossed once.
 */
const NAME_WORD_GLOSSES: Readonly<Record<string, string>> = {
  read: 'lesen',
  list: 'auflisten liste',
  get: 'abrufen anzeigen',
  create: 'anlegen erstellen neu',
  update: 'aendern bearbeiten',
  set: 'setzen stellen',
  search: 'suchen durchsuchen',
  start: 'starten',
  cancel: 'abbrechen',
  build: 'kompilieren bauen',
  builds: 'kompilierlaeufe',
  file: 'datei',
  files: 'dateien',
  page: 'seite',
  run: 'lauf',
  runs: 'laeufe',
  send: 'senden schicken',
  message: 'nachricht',
  messages: 'nachrichten',
  propose: 'vorschlagen',
  submit: 'einreichen',
  link: 'verknuepfen',
  request: 'anfragen stellen',
  note: 'notiz',
  checkpoint: 'arbeitsstand festhalten',
  checkpoints: 'arbeitsstaende',
  preferences: 'einstellungen',
  devices: 'geraete',
  device: 'geraet',
  template: 'vorlage',
  overview: 'uebersicht',
  cover: 'titelbild',
  layout: 'breite',
  export: 'exportieren',
  upload: 'hochladen',
};

function nameText(name: string): string {
  const words = name.split('_');
  return [...words, ...words.map((word) => NAME_WORD_GLOSSES[word] ?? '')].join(' ');
}

/** The words of a query worth matching, stemmed and without duplicates. */
export function queryTerms(query: string): string[] {
  const words = wordsOf(foldText(query)).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
  return [...new Set(words.map(stem))];
}

/** One searchable field of a tool, folded once. */
interface Field {
  weight: number;
  text: string;
}

function field(weight: number, text: string): Field {
  return { weight, text: foldText(text) };
}

/** A German linking element between the parts of a compound ("Seitenbreite"). */
const LINKS = ['', 's', 'n', 'en', 'e', 'es'];

/**
 * The parts of a compound query word, from the vocabulary of the tools
 * themselves, or `null` when it does not come apart into at least two.
 *
 * Fewest parts wins: "seitenbreite" is "seite" + "n" + "breite", not five
 * fragments. Every part has four letters at least, because a shorter one is
 * inside half the words of any text.
 */
function splitCompound(term: string, vocabulary: ReadonlySet<string>): string[] | null {
  if (term.length < 8) return null;
  // best[i]: the fewest parts that spell term[0, i), and the parts.
  const best: (string[] | null)[] = new Array<string[] | null>(term.length + 1).fill(null);
  best[0] = [];
  for (let end = 4; end <= term.length; end += 1) {
    for (let start = 0; start <= end - 4; start += 1) {
      const before = best[start] ?? null;
      if (before === null) continue;
      for (const link of LINKS) {
        const wordEnd = end - link.length;
        if (wordEnd - start < 4 || term.slice(wordEnd, end) !== link) continue;
        // The whole word is not a part of itself; whether it stands in a
        // text as a whole is the direct match in `coverage`.
        if (start === 0 && end === term.length) continue;
        const word = term.slice(start, wordEnd);
        if (!vocabulary.has(word) && !vocabulary.has(stem(word))) continue;
        const candidate = [...before, word];
        const current = best[end] ?? null;
        if (current === null || candidate.length < current.length) best[end] = candidate;
      }
    }
  }
  const parts = best[term.length] ?? null;
  return parts !== null && parts.length >= 2 ? parts : null;
}

/**
 * How much of `term` this field accounts for, from 0 to 1.
 *
 * 1 when the term stands in the text, alone or inside a longer word. Short of
 * that, the share of a compound's letters whose parts stand in the text:
 * "seitenbreite" is covered by a description saying "Breite des
 * Seitenkörpers" completely, by one that only mentions a page to half, which
 * is what lets the layout tool outrank every other tool that names a page.
 */
function coverage(term: string, parts: readonly string[] | null, target: Field): number {
  if (target.text.includes(term)) return 1;
  if (parts === null) return 0;
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const found = parts
    .filter((part) => target.text.includes(stem(part)))
    .reduce((sum, part) => sum + part.length, 0);
  return found / total;
}

export interface RankedTool {
  tool: AnyToolDefinition;
  score: number;
}

/**
 * Scores every tool against the query and returns the ones that matched at
 * all, best first. Ties go to `prefer` (the tools the caller may run), then by
 * name, so the same query always answers in the same order.
 */
export function rankTools(input: {
  tools: readonly AnyToolDefinition[];
  query: string;
  searchText?: ReadonlyMap<string, string>;
  prefer?: ReadonlySet<string>;
}): RankedTool[] {
  const terms = queryTerms(input.query);
  if (terms.length === 0) return [];
  const prefer = input.prefer ?? new Set<string>();

  const indexed = input.tools.map((tool) => ({
    tool,
    fields: [
      field(3, nameText(tool.name)),
      field(2, tool.description),
      field(1, `${domainLabel(tool.domain)} ${domainKeywords(tool.domain).join(' ')}`),
      field(1, input.searchText?.get(tool.name) ?? ''),
    ],
  }));

  // Every word the tools are described with, for taking a compound apart.
  const vocabulary = new Set<string>();
  for (const entry of indexed) {
    for (const target of entry.fields) {
      for (const word of wordsOf(target.text)) {
        if (word.length >= 4 && !STOPWORDS.has(word)) {
          vocabulary.add(word);
          vocabulary.add(stem(word));
        }
      }
    }
  }
  const split = new Map(terms.map((term) => [term, splitCompound(term, vocabulary)]));

  // Per tool and term, how well each field covers it.
  const covered = indexed.map(({ tool, fields }) => ({
    tool,
    perTerm: terms.map((term) => {
      const parts = split.get(term) ?? null;
      return fields.reduce((sum, target) => sum + target.weight * coverage(term, parts, target), 0);
    }),
  }));
  // A word every tool carries ("Seite" in a catalogue of pages) decides
  // nothing; a word three tools carry decides almost everything. Inverse
  // document frequency, the oldest answer to that.
  const rarity = terms.map((_term, index) => {
    const carriers = covered.filter((entry) => (entry.perTerm[index] ?? 0) > 0).length;
    return carriers === 0 ? 0 : Math.log(1 + indexed.length / carriers);
  });

  return covered
    .map(({ tool, perTerm }) => ({
      tool,
      score: perTerm.reduce((sum, value, index) => sum + value * (rarity[index] ?? 0), 0),
    }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(prefer.has(b.tool.name)) - Number(prefer.has(a.tool.name)) ||
        a.tool.name.localeCompare(b.tool.name),
    );
}
