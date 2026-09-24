import {
  type ContextMatch,
  type ContextSource,
  type DocumentPathEntry,
} from '@exocortex/contracts';

import { chunkPlainText } from './chunking';
import { type SearchHit } from './search';

/**
 * The pure half of the context compiler (issue #110, ADR-061).
 *
 * Everything here works on lists that are already in memory: cutting a page
 * that the keywords found into passages, fusing the keyword and the semantic
 * passage lists, and packing the result into a budget. None of it reads the
 * database or calls a model, which is what makes the evaluation set in
 * `context-packing.test.ts` reproducible: identical candidates always pack to
 * the identical answer.
 */

/** Where a passage sits on its page. Same shape as on a search hit. */
export type PassageSection = SearchHit['section'];

/**
 * One passage that could go into an answer.
 *
 * `ordinal` is the passage's position on its page in the cut of
 * `chunkPlainText`, and together with the page it is the passage's identity
 * for this one request. It is not an identity beyond it: the stored
 * `chunk:NNNN` ids are ordinal too and move whenever the page does (ADR-034),
 * so nothing outside this process is ever told about them.
 */
export interface PassageCandidate {
  documentId: string;
  workspaceId: string;
  title: string;
  updatedAt: string;
  ordinal: number;
  text: string;
  section: PassageSection;
  /** Fused score; only comparable within one answer. */
  score: number;
  match: ContextMatch;
  /**
   * An exact keyword hit that a semantic ranking may not push out: every word
   * of the question occurs in it, and its page is among the first keyword
   * pages. Packed ahead of everything else.
   */
  protected: boolean;
}

/** Most passages one keyword-matched page contributes before fusion. */
export const KEYWORD_PASSAGES_PER_PAGE = 3;

/** How many of the leading keyword pages have their best exact passage protected. */
export const PROTECTED_KEYWORD_PAGES = 3;

/**
 * Longest page cut at request time, in passages.
 *
 * Higher than the 64 the embeddings stop at, because the keyword half is where
 * the rest of a very long page is still reachable at all, and cutting text in
 * memory costs no model call. It is still a ceiling: a page of two million
 * characters is not worth a thousand candidates.
 */
const KEYWORD_MAX_CHUNKS = 256;

/** Same constant `fuse` uses for pages; see there. */
const RRF_K = 60;

/**
 * The words of a question, as the full-text half understands them.
 *
 * Deliberately the same split as `buildTsQuery`: a passage is judged by the
 * words that made its page a hit, prefix-matched just as `:*` does.
 */
export function keywordTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^\p{Letter}\p{Number}_]+/u)
        .filter((token) => token.length > 0)
        .slice(0, 10),
    ),
  ];
}

/** How many of `tokens` a text contains, and how often any of them occurs. */
export function keywordCoverage(
  text: string,
  tokens: readonly string[],
): { distinct: number; occurrences: number } {
  if (tokens.length === 0) return { distinct: 0, occurrences: 0 };
  const words = text.toLowerCase().split(/[^\p{Letter}\p{Number}_]+/u);
  const seen = new Set<string>();
  let occurrences = 0;
  for (const word of words) {
    if (word.length === 0) continue;
    for (const token of tokens) {
      if (word.startsWith(token)) {
        seen.add(token);
        occurrences += 1;
      }
    }
  }
  return { distinct: seen.size, occurrences };
}

/**
 * The passages of one page as `chunkPlainText` cuts it, a short page being one
 * passage of its own.
 *
 * The same cut the embeddings were built from, which is what lets a passage
 * found by both halves be recognised as one passage: same page, same ordinal,
 * same text.
 */
export function passagesOfPage(plainText: string): { ordinal: number; text: string }[] {
  const chunks = chunkPlainText(plainText, { maxChunks: KEYWORD_MAX_CHUNKS });
  if (chunks.length > 0)
    return chunks.map((chunk) => ({ ordinal: chunk.ordinal, text: chunk.text }));
  const text = plainText.trim();
  return text.length === 0 ? [] : [{ ordinal: 0, text }];
}

export interface KeywordPage {
  documentId: string;
  workspaceId: string;
  title: string;
  updatedAt: string;
  plainText: string;
}

/** A passage in one of the two lists, before fusion. */
export interface RankedPassage {
  documentId: string;
  workspaceId: string;
  title: string;
  updatedAt: string;
  ordinal: number;
  text: string;
  section: PassageSection;
  /** Every word of the question occurs in it. Only meaningful in the keyword list. */
  exact: boolean;
}

/**
 * The keyword passage list: the pages the full-text search ranked, cut into
 * passages, each page's passages ordered by how many of the words they carry.
 *
 * Interleaved by round rather than page after page. Page after page would hand
 * the first page's three passages the first three places, and fusion reads
 * places; round by round, the second-best passage of the best page competes
 * with the best passage of the fourth page, which is the comparison that
 * matters.
 *
 * A page that matched by its title alone keeps its first passage: the title
 * was the evidence, and the opening of a page is what it is about. A page
 * whose own text and title carry none of the words contributes nothing: the
 * search found it by text this list does not include (its attachments, see
 * `PostgresPassageSearch.keywordPages`), and its opening is no answer.
 */
export function keywordPassageList(
  pages: readonly KeywordPage[],
  tokens: readonly string[],
): RankedPassage[] {
  const perPage = pages.map((page) => {
    const scored = passagesOfPage(page.plainText).map((passage) => ({
      passage,
      coverage: keywordCoverage(passage.text, tokens),
    }));
    const matching = scored
      .filter((entry) => entry.coverage.distinct > 0)
      .sort(
        (a, b) =>
          b.coverage.distinct - a.coverage.distinct ||
          b.coverage.occurrences - a.coverage.occurrences ||
          a.passage.ordinal - b.passage.ordinal,
      );
    const titleMatched = keywordCoverage(page.title, tokens).distinct > 0;
    const fallback = titleMatched ? scored.slice(0, 1) : [];
    const chosen = (matching.length > 0 ? matching : fallback).slice(0, KEYWORD_PASSAGES_PER_PAGE);
    return chosen.map((entry): RankedPassage => ({
      documentId: page.documentId,
      workspaceId: page.workspaceId,
      title: page.title,
      updatedAt: page.updatedAt,
      ordinal: entry.passage.ordinal,
      text: entry.passage.text,
      section: null,
      exact: tokens.length > 0 && entry.coverage.distinct === tokens.length,
    }));
  });

  const list: RankedPassage[] = [];
  for (let round = 0; round < KEYWORD_PASSAGES_PER_PAGE; round += 1) {
    for (const passages of perPage) {
      const passage = passages[round];
      if (passage !== undefined) list.push(passage);
    }
  }
  return list;
}

function passageKey(passage: { documentId: string; ordinal: number }): string {
  return `${passage.documentId}#${passage.ordinal}`;
}

/**
 * Reciprocal rank fusion of the two passage lists.
 *
 * The same method and constant as `fuse` for pages, applied one level finer.
 * A passage both halves found is one entry and says `both`; the semantic half
 * contributes its section, because only it stored one.
 *
 * Protected passages are the exact keyword hits of the leading keyword pages,
 * and they are sorted first whatever the fusion made of them: a question that
 * names a file or a term verbatim has an answer that a vector may rank
 * anywhere, and the issue is explicit that it must not disappear.
 */
export function fusePassages(
  keyword: readonly RankedPassage[],
  semantic: readonly RankedPassage[],
  weight: number,
): PassageCandidate[] {
  const clamped = Math.min(Math.max(weight, 0), 1);
  const entries = new Map<string, PassageCandidate>();

  const leadingPages = new Set<string>();
  for (const passage of keyword) {
    if (leadingPages.size >= PROTECTED_KEYWORD_PAGES) break;
    leadingPages.add(passage.documentId);
  }
  const protectedPages = new Set<string>();

  keyword.forEach((passage, position) => {
    const key = passageKey(passage);
    const guarded =
      passage.exact &&
      leadingPages.has(passage.documentId) &&
      !protectedPages.has(passage.documentId);
    if (guarded) protectedPages.add(passage.documentId);
    const existing = entries.get(key);
    const score = (1 - clamped) / (RRF_K + position + 1);
    if (existing === undefined) {
      entries.set(key, { ...withoutExact(passage), score, match: 'keyword', protected: guarded });
    } else {
      existing.score += score;
      existing.protected ||= guarded;
    }
  });

  semantic.forEach((passage, position) => {
    const key = passageKey(passage);
    const score = clamped / (RRF_K + position + 1);
    const existing = entries.get(key);
    if (existing === undefined) {
      entries.set(key, { ...withoutExact(passage), score, match: 'semantic', protected: false });
      return;
    }
    existing.score += score;
    existing.match = 'both';
    if (existing.section === null) existing.section = passage.section;
  });

  return [...entries.values()].sort(
    (a, b) =>
      Number(b.protected) - Number(a.protected) ||
      b.score - a.score ||
      a.documentId.localeCompare(b.documentId) ||
      a.ordinal - b.ordinal,
  );
}

function withoutExact(passage: RankedPassage): Omit<RankedPassage, 'exact'> {
  const { exact: _exact, ...rest } = passage;
  return rest;
}

/** What a page is, for the header above its passages. */
export interface PackSource {
  documentId: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  path: readonly DocumentPathEntry[];
  updatedAt: string;
}

export interface PackOptions {
  maxChars: number;
  maxSources: number;
  perSourceMaxChars: number;
}

export interface PackResult {
  sources: ContextSource[];
  text: string;
  truncated: boolean;
  selected: number;
}

/**
 * How much the next passage from a page that already contributed counts,
 * relative to its score. Halving per passage is what lets a second, clearly
 * relevant passage of one page still beat a weak first passage of another,
 * while three near-identical ones from the same page do not.
 */
export const SAME_SOURCE_DECAY = 0.5;

/** Shortest cut passage worth handing over; below it the passage is dropped instead. */
export const MIN_CUT_CHARS = 300;

/** Default share of the budget one page may take. */
export function defaultPerSourceMaxChars(maxChars: number, maxSources: number): number {
  if (maxSources <= 1) return maxChars;
  return Math.min(maxChars, Math.max(Math.floor(maxChars / 3), 800));
}

interface ChosenPassage {
  candidate: PassageCandidate;
  text: string;
  truncated: boolean;
}

/**
 * The passages that fit, chosen greedily.
 *
 * Each step takes the remaining candidate with the highest score after the
 * same-page decay, protected ones first, and admits it when the rendered answer
 * stays inside both the total and the page's ceiling. Costs are measured on
 * the rendered text itself rather than estimated, so `maxChars` is a promise
 * about the characters returned. A candidate that does not fit is cut at a word
 * boundary when enough of it survives, and dropped otherwise.
 *
 * Text that is already in the answer is not paid for twice: a passage whose
 * text is word for word one that was chosen (the same paragraph on two pages)
 * is skipped, and the overlap `chunkPlainText` repeats at the start of the
 * next passage of the same page is removed when both are chosen.
 */
export function packContext(
  candidates: readonly PassageCandidate[],
  sources: ReadonlyMap<string, PackSource>,
  options: PackOptions,
): PackResult {
  const remaining = candidates.filter((candidate) => sources.has(candidate.documentId));
  const chosen = new Map<string, ChosenPassage[]>();
  const seenTexts = new Set<string>();
  let truncated = false;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    remaining.forEach((candidate, index) => {
      const taken = chosen.get(candidate.documentId)?.length ?? 0;
      const adjusted =
        (candidate.protected ? 1_000 : 0) + candidate.score * SAME_SOURCE_DECAY ** taken;
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestIndex = index;
      }
    });
    const [candidate] = remaining.splice(bestIndex, 1);
    if (candidate === undefined) break;

    const normalised = candidate.text.replace(/\s+/g, ' ').trim();
    if (normalised.length === 0 || seenTexts.has(normalised)) continue;

    const current = chosen.get(candidate.documentId);
    // The two halves can cut the same page differently where the page ends
    // and its attachment text began, so a short page's whole text and a
    // passage of it may both arrive. Whichever came second says nothing new.
    if (current?.some((passage) => containsEither(passage.candidate.text, candidate.text))) {
      continue;
    }
    if (current === undefined && chosen.size >= options.maxSources) {
      truncated = true;
      continue;
    }

    const admitted = admit(candidate, current ?? [], chosen, sources, options);
    if (admitted === null) {
      truncated = true;
      continue;
    }
    if (admitted.truncated) truncated = true;
    seenTexts.add(normalised);
    chosen.set(candidate.documentId, admitted.passages);
  }

  const ordered = [...chosen.entries()];
  const blocks = ordered.map(([documentId, passages]) =>
    renderSource(sources.get(documentId) as PackSource, passages),
  );
  const text = blocks.join(SOURCE_SEPARATOR);
  return {
    sources: ordered.map(([documentId, passages]) => {
      const source = sources.get(documentId) as PackSource;
      return {
        workspaceId: source.workspaceId,
        workspaceName: source.workspaceName,
        documentId,
        title: source.title,
        path: [...source.path],
        updatedAt: source.updatedAt,
        passages: renderedPassages(passages).map((passage) => ({
          text: passage.text,
          score: passage.candidate.score,
          match: passage.candidate.match,
          section: passage.candidate.section,
          truncated: passage.truncated,
        })),
      };
    }),
    text,
    truncated,
    selected: ordered.reduce((sum, [, passages]) => sum + passages.length, 0),
  };
}

function containsEither(a: string, b: string): boolean {
  const left = a.replace(/\s+/g, ' ').trim();
  const right = b.replace(/\s+/g, ' ').trim();
  return left.includes(right) || right.includes(left);
}

/**
 * The page's passages with this candidate added, or `null` when not even a cut
 * of it fits.
 */
function admit(
  candidate: PassageCandidate,
  current: readonly ChosenPassage[],
  chosen: ReadonlyMap<string, ChosenPassage[]>,
  sources: ReadonlyMap<string, PackSource>,
  options: PackOptions,
): { passages: ChosenPassage[]; truncated: boolean } | null {
  const source = sources.get(candidate.documentId) as PackSource;
  const others = [...chosen.entries()]
    .filter(([documentId]) => documentId !== candidate.documentId)
    .reduce(
      (sum, [documentId, passages]) =>
        sum + renderSource(sources.get(documentId) as PackSource, passages).length,
      0,
    );
  const separators =
    SOURCE_SEPARATOR.length * Math.max(0, chosen.size - (current.length > 0 ? 1 : 0));
  const budgetHere = Math.min(options.perSourceMaxChars, options.maxChars - others - separators);

  const full = [...current, { candidate, text: candidate.text, truncated: false }];
  const fullLength = renderSource(source, full).length;
  if (fullLength <= budgetHere) return { passages: full, truncated: false };

  const without = current.length === 0 ? 0 : renderSource(source, current).length;
  const room = candidate.text.length - (fullLength - budgetHere);
  if (room < MIN_CUT_CHARS || budgetHere <= without) return null;

  const cut = cutAtWord(candidate.text, room);
  const passages = [...current, { candidate, text: cut, truncated: true }];
  // The overlap removal can only make the text shorter, so a cut sized
  // against the full text fits; checked anyway, because the budget is a
  // promise and a miscount here would break it silently.
  if (renderSource(source, passages).length > budgetHere) return null;
  return { passages, truncated: true };
}

const ELLIPSIS = ' …';

/** The start of `text`, at most `length` characters including the ellipsis. */
function cutAtWord(text: string, length: number): string {
  const room = length - ELLIPSIS.length;
  if (room <= 0) return '';
  const window = text.slice(0, room);
  const space = window.lastIndexOf(' ');
  const cut = space > room / 2 ? window.slice(0, space) : window;
  return `${cut.trimEnd()}${ELLIPSIS}`;
}

const SOURCE_SEPARATOR = '\n\n';

/** A page's chosen passages in page order, the repeated overlap removed. */
function renderedPassages(passages: readonly ChosenPassage[]): ChosenPassage[] {
  const ordered = [...passages].sort((a, b) => a.candidate.ordinal - b.candidate.ordinal);
  return ordered.map((passage, index) => {
    const previous = ordered[index - 1];
    if (previous === undefined || previous.candidate.ordinal !== passage.candidate.ordinal - 1) {
      return passage;
    }
    return { ...passage, text: withoutOverlap(previous.candidate.text, passage.text) };
  });
}

/**
 * `next` without the lines it repeats from the end of `previous`.
 *
 * `chunkPlainText` starts a passage with the tail of the one before it, up to
 * a line break, so the repeated part always ends right before a newline in
 * `next`. Only those positions are tried.
 */
export function withoutOverlap(previous: string, next: string): string {
  for (
    let index = next.indexOf('\n');
    index !== -1 && index <= 400;
    index = next.indexOf('\n', index + 1)
  ) {
    const repeated = next.slice(0, index);
    if (repeated.length > 0 && previous.endsWith(repeated)) return next.slice(index + 1);
  }
  return next;
}

function renderSource(source: PackSource, passages: readonly ChosenPassage[]): string {
  const location = [source.workspaceName, ...source.path.map((entry) => entry.title)].join(' › ');
  const header = `## ${source.title}\n${location} · Stand ${source.updatedAt.slice(0, 10)} · id ${source.documentId}`;
  const body = renderedPassages(passages).map((passage) => {
    const section = passage.candidate.section;
    if (section === null || section.path.length === 0) return passage.text;
    const anchor = section.blockId === null ? '' : ` (^${section.blockId})`;
    return `Abschnitt: ${section.path.join(' › ')}${anchor}\n${passage.text}`;
  });
  return [header, ...body].join('\n\n');
}
