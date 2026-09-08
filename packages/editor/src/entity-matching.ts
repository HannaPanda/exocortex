/**
 * Finding names in a page's text (issue #47).
 *
 * Lives next to `document-links` for the same reason that one does: both turn
 * a materialized document into edges, both must produce the exact same answer
 * in the API and in the worker, and a matcher that disagrees with itself
 * between the two is a class of bug nothing else in the repository would catch.
 *
 * Deliberately deterministic and free. The expensive way to do this is to ask a
 * model which entities a page is about; the cheap way answers the same question
 * for the names somebody has already written down, which is the only set the
 * matcher is allowed to link to anyway.
 */

/** Longest sentence the context preview keeps. */
const MAX_CONTEXT_CHARS = 240;

/**
 * The key an alias is compared under.
 *
 * Case and inner whitespace are noise: "Second Brain", "second  brain" and
 * "SECOND BRAIN" are one name. Punctuation is not stripped, because `fpb2` and
 * `f.p.b.2` are not obviously the same host and guessing that they are is how a
 * matcher starts inventing connections.
 */
export function entityAliasKey(alias: string): string {
  return alias.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Splits the `Aliasse` column into names.
 *
 * Comma-separated, because that is what a person types into a text column
 * without being taught a syntax. Empty parts are dropped rather than rejected:
 * a trailing comma is not an error worth an error message.
 */
export function parseEntityAliases(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const part of value.split(/[,;\n]/)) {
    const alias = part.trim().replace(/\s+/g, ' ');
    if (alias.length === 0) continue;
    const key = entityAliasKey(alias);
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

/** Serializes aliases back into the shape the column holds. */
export function formatEntityAliases(aliases: readonly string[]): string {
  return aliases.join(', ');
}

/** Escapes a literal so it can sit inside a regular expression. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word boundaries that work for German and for host names.
 *
 * `\b` is the wrong tool here twice over: it treats `ä` as a boundary in some
 * engines, and it treats the `-` in `exocortex-api` as one always, so the alias
 * `exocortex` would match inside the unrelated name of a systemd unit. The
 * lookarounds below say "not preceded or followed by something a name can be
 * made of", which is the property actually wanted.
 */
const NAME_CHARACTER = '[\\p{L}\\p{N}_\\-]';

function aliasPattern(alias: string): RegExp {
  return new RegExp(`(?<!${NAME_CHARACTER})${escapeForRegExp(alias)}(?!${NAME_CHARACTER})`, 'giu');
}

export interface EntityAliasCandidate {
  /** The entity this alias belongs to. Opaque to the matcher. */
  entityId: string;
  alias: string;
}

export interface EntityAliasMatch {
  entityId: string;
  /** The alias as configured, not as written: the profile groups by it. */
  alias: string;
  aliasKey: string;
  occurrences: number;
  /** Sentence around the first occurrence, trimmed. */
  context: string;
}

/**
 * The sentence a position sits in, capped.
 *
 * A sentence rather than a fixed window, because the preview is read by a
 * person deciding whether to open the page, and half a clause tells them
 * nothing. Falls back to a window when the "sentence" is a whole paragraph of
 * bullet points without a full stop, which is what most notes look like.
 */
export function sentenceAround(text: string, index: number): string {
  const before = text.slice(Math.max(0, index - MAX_CONTEXT_CHARS), index);
  const after = text.slice(index, index + MAX_CONTEXT_CHARS);
  const start = Math.max(
    before.lastIndexOf('. '),
    before.lastIndexOf('\n'),
    before.lastIndexOf('! '),
    before.lastIndexOf('? '),
  );
  const endCandidates = [after.indexOf('. '), after.indexOf('\n'), after.indexOf('! ')].filter(
    (position) => position >= 0,
  );
  const end = endCandidates.length === 0 ? after.length : Math.min(...endCandidates) + 1;
  return `${before.slice(start + 1)}${after.slice(0, end)}`.trim().slice(0, MAX_CONTEXT_CHARS);
}

/**
 * Which of the given aliases appear in the text, and how often.
 *
 * One entity is reported once however many of its aliases hit: the answer to
 * "does this page talk about fpb2" is yes or no, not "three times as fpb2 and
 * once as der Hetzner-Server". The alias reported is the one that appeared
 * most, because that is the name this page actually uses.
 */
export function matchEntityAliases(
  text: string,
  candidates: readonly EntityAliasCandidate[],
  options?: { minAliasLength?: number },
): EntityAliasMatch[] {
  const minLength = options?.minAliasLength ?? 3;
  if (text.length === 0) return [];

  const perEntity = new Map<string, EntityAliasMatch>();
  for (const candidate of candidates) {
    if (candidate.alias.length < minLength) continue;
    const pattern = aliasPattern(candidate.alias);
    let occurrences = 0;
    let firstIndex = -1;
    let hit: RegExpExecArray | null;
    while ((hit = pattern.exec(text)) !== null) {
      occurrences += 1;
      if (firstIndex < 0) firstIndex = hit.index;
      // A zero-length match cannot happen with a non-empty alias, but an alias
      // is user input and a stuck `lastIndex` is an infinite loop, not a bug
      // report.
      if (hit.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
    if (occurrences === 0) continue;

    const previous = perEntity.get(candidate.entityId);
    if (previous !== undefined && previous.occurrences >= occurrences) {
      previous.occurrences += occurrences;
      continue;
    }
    perEntity.set(candidate.entityId, {
      entityId: candidate.entityId,
      alias: candidate.alias,
      aliasKey: entityAliasKey(candidate.alias),
      occurrences: occurrences + (previous?.occurrences ?? 0),
      context: sentenceAround(text, firstIndex),
    });
  }

  return [...perEntity.values()].sort((a, b) => b.occurrences - a.occurrences);
}

export interface EntityPhrase {
  phrase: string;
  phraseKey: string;
  occurrences: number;
  context: string;
}

/**
 * Words that start a German sentence often enough to be noise rather than names.
 *
 * The list is short on purpose. Its job is not to be a stop-word dictionary but
 * to catch the handful of words that would otherwise be the top candidate on
 * every single page, and every entry past that is a name somebody cannot
 * propose any more.
 */
const SENTENCE_STARTERS = new Set([
  'der',
  'die',
  'das',
  'den',
  'dem',
  'des',
  'ein',
  'eine',
  'einen',
  'einem',
  'einer',
  'und',
  'oder',
  'aber',
  'wenn',
  'dann',
  'also',
  'nur',
  'noch',
  'schon',
  'hier',
  'dort',
  'damit',
  'dafür',
  'deshalb',
  'nicht',
  'kein',
  'keine',
  'was',
  'wer',
  'wie',
  'warum',
  'wo',
  'es',
  'ich',
  'du',
  'er',
  'sie',
  'wir',
  'ihr',
  'man',
  'für',
  'mit',
  'ohne',
  'nach',
  'vor',
  'bei',
  'aus',
  'auf',
  'im',
  'am',
  'zum',
  'zur',
  'als',
  'seit',
  'diese',
  'dieser',
  'dieses',
  'jede',
  'jeder',
  'alle',
  'siehe',
  'stand',
]);

/**
 * Something that looks like a proper name: a capitalized word, or a run of them,
 * optionally with a lowercase connector in the middle ("Bank für Gemeinwohl").
 */
const PROPER_NAME =
  /\p{Lu}[\p{L}\p{N}_-]+(?:\s+(?:von|van|de|für|und|der|am)?\s*\p{Lu}[\p{L}\p{N}_-]+)*/gu;
/** A bare identifier: `fpb2`, `exocortex-api`, `pgvector`. Lowercase and digits or dashes. */
const IDENTIFIER =
  /(?<![\p{L}\p{N}_-])[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+(?![\p{L}\p{N}_-])|(?<![\p{L}\p{N}_-])[a-z]{3,}\d+(?![\p{L}\p{N}_-])/gu;

/**
 * Names on a page that no entity answers to yet.
 *
 * Everything about this is conservative, because the failure mode is not
 * "missed a name" but "a suggestion list nobody will ever read again". A phrase
 * has to look like a name, appear at least twice on the page, and not be one of
 * the words every German page starts a sentence with.
 */
export function findEntityPhrases(
  text: string,
  options: {
    /** Keys already claimed by an entity or already dismissed. */
    known: ReadonlySet<string>;
    minLength?: number;
    /** Phrases to report at most, best first. */
    limit?: number;
  },
): EntityPhrase[] {
  const minLength = options.minLength ?? 3;
  const limit = options.limit ?? 20;
  const found = new Map<string, { phrase: string; occurrences: number; firstIndex: number }>();

  for (const pattern of [PROPER_NAME, IDENTIFIER]) {
    pattern.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = pattern.exec(text)) !== null) {
      const phrase = hit[0].trim();
      if (phrase.length < minLength) continue;
      const key = entityAliasKey(phrase);
      if (options.known.has(key)) continue;
      if (SENTENCE_STARTERS.has(key)) continue;
      const existing = found.get(key);
      if (existing === undefined) {
        found.set(key, { phrase, occurrences: 1, firstIndex: hit.index });
      } else {
        existing.occurrences += 1;
      }
    }
  }

  return (
    [...found.entries()]
      // Once is a mention, twice on the same page is somebody talking about a
      // thing. The page threshold on top of this is what makes it evidence.
      .filter(([, value]) => value.occurrences >= 2)
      .sort((a, b) => b[1].occurrences - a[1].occurrences)
      .slice(0, limit)
      .map(([phraseKey, value]) => ({
        phrase: value.phrase,
        phraseKey,
        occurrences: value.occurrences,
        context: sentenceAround(text, value.firstIndex),
      }))
  );
}
