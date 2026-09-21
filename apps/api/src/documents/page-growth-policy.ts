import { buildDocumentMap, type DocumentMap, type ProseMirrorDocument } from '@exocortex/editor';

/**
 * How large a page an agent may grow, and what it is told on the way (#118).
 *
 * The problem this answers is not that pages get big. It is that an agent
 * appends to a page it has never seen whole -- that is the point of a budgeted
 * read (ADR-056) -- and so nothing in the loop ever notices that the page has
 * become the place where everything goes. A person in the editor sees the
 * scrollbar. A tool call sees a success.
 *
 * So the size of the result is judged where the result is worked out, and the
 * answer carries it back: at `large` as a sentence naming the biggest sections,
 * above `oversized` as a refusal naming the same sections and the tool that
 * moves one away. The sections matter more than the number. "This page is
 * 62,000 characters" is a fact nobody can act on; "its biggest section is
 * 'Befunde' with 18,000 characters, and `exo_page_extract_section` moves it"
 * is the next call.
 *
 * Pure, so the whole policy is provable without a database, and shared, because
 * the whole-page write and the narrow ones must not drift into two answers to
 * the same question -- a limit one of them enforces is a limit the other one is
 * the way around.
 */

/** Sections a warning or a refusal names before the list stops being read. */
const NAMED_SECTIONS = 3;

/**
 * The share of the page a section has to be before it is worth naming.
 *
 * A share rather than a number of characters, because the question is not how
 * big the section is but whether moving it away would change anything: a 3,000
 * character section is most of a page of 12,000 and a rounding error on one of
 * 900,000, and a fixed threshold would say the same thing about both.
 */
const WORTH_NAMING_SHARE = 0.1;

export type PageGrowthLevel = 'normal' | 'large' | 'oversized';

export interface PageGrowthLimits {
  /** Above this, a write is answered with the page's size and its sections. */
  largeChars: number;
  /** Above this, a write that makes the page bigger is refused. */
  oversizedChars: number;
}

export interface PageGrowthVerdict {
  level: PageGrowthLevel;
  /** `true` when this write leaves the page larger than it found it. */
  grew: boolean;
  /** Characters of Markdown the page holds afterwards. */
  chars: number;
}

/**
 * Reads the two limits out of resolved settings, in an order that holds.
 *
 * A deployment can be configured with a warning threshold above its refusal
 * threshold, and the two settings cannot validate each other: each is written
 * on its own, and the workspace clamp (ADR-023) can lower either one without
 * the other moving. Rather than refuse the configuration -- which would leave a
 * deployment unable to write anything until an admin fixes a number -- the
 * warning follows the refusal down, because a level nobody can ever reach
 * without being refused first is not a warning level.
 */
export function pageGrowthLimits(settings: {
  'agents.largePageChars': number;
  'agents.oversizedPageChars': number;
}): PageGrowthLimits {
  const oversizedChars = settings['agents.oversizedPageChars'];
  return {
    oversizedChars,
    largeChars: Math.min(settings['agents.largePageChars'], oversizedChars),
  };
}

/**
 * What this write makes of the page.
 *
 * `after` is the Markdown this write produces, never the page's stored
 * `markdown` column: that one is derived by a job and may be a write or two
 * behind (ADR-005), and a limit judged against a stale number is a limit that
 * lets one more write through every time.
 *
 * Growth is part of the verdict because refusing by size alone would trap a
 * page that is already over the limit: nothing could rewrite it smaller,
 * nothing could correct a sentence in it, and the only remaining operation
 * would be deleting it.
 */
export function judgePageGrowth(input: {
  before: number;
  after: number;
  limits: PageGrowthLimits;
}): PageGrowthVerdict {
  const grew = input.after > input.before;
  const level: PageGrowthLevel =
    input.after > input.limits.oversizedChars
      ? 'oversized'
      : input.after > input.limits.largeChars
        ? 'large'
        : 'normal';
  return { level, grew, chars: input.after };
}

/**
 * The biggest sections of a page, largest first, as a map already measured them.
 *
 * Sections only, never the block windows a map falls back to on a page without
 * headings (ADR-056). A window is addressable and a section is a thing with a
 * name, and "move blocks 41 to 80 onto their own page" is advice nobody can
 * weigh: what the new page would be about is precisely what is missing.
 */
function biggestSections(map: DocumentMap): string[] {
  const worthNaming = map.totalChars * WORTH_NAMING_SHARE;
  return [...map.entries]
    .filter(
      (entry) =>
        entry.kind === 'section' && entry.fromBlockId !== null && entry.chars >= worthNaming,
    )
    .sort((left, right) => right.chars - left.chars)
    .slice(0, NAMED_SECTIONS)
    .map(
      (entry) => `„${entry.title}“ (^${entry.fromBlockId ?? ''}, ${format(entry.chars)} Zeichen)`,
    );
}

function format(chars: number): string {
  return chars.toLocaleString('de-DE');
}

/**
 * The sentence appended to a successful write on a page that has got large.
 *
 * It is a warning and not a refusal because a large page is not a defect: a
 * reference page that genuinely is one topic is allowed to be long. What it
 * must not be is a surprise, and everything a reader needs to act is in the
 * sentence -- the size, the sections, and the fact that a subpage is the
 * alternative to one more append.
 */
export function largePageWarning(document: ProseMirrorDocument, chars: number): string {
  const sections = biggestSections(buildDocumentMap(document, { totalChars: chars }));
  const opening =
    `Diese Seite ist jetzt ${format(chars)} Zeichen lang. Wenn das Nächste, was du schreibst, ` +
    'ein eigenes Thema ist, gehört es auf eine Unterseite statt ans Ende dieser Seite.';
  if (sections.length === 0) return opening;
  return `${opening} Die größten Abschnitte: ${sections.join(', ')}.`;
}

/**
 * Why a write was refused, and what to do instead.
 *
 * Three ways out, in the order they are worth trying, and each one is a call
 * that exists: move a section away, write the new material to its own page, or
 * change a section in place rather than adding to the end. A refusal that only
 * says no teaches a model to retry in halves until it fits, which is the same
 * page arriving in four writes instead of one.
 */
export function oversizedPageRefusal(
  document: ProseMirrorDocument,
  input: { current: number; after: number; limit: number },
): string {
  const sections = biggestSections(buildDocumentMap(document, { totalChars: input.current }));
  const named =
    sections.length === 0
      ? ''
      : ` Die größten Abschnitte dieser Seite: ${sections.join(', ')}.` +
        ' Einen davon verschiebt exo_page_extract_section in einem Aufruf auf eine eigene Seite.';
  return (
    `Diese Seite hat ${format(input.current)} Zeichen und wäre danach ${format(input.after)}; ` +
    `ab ${format(input.limit)} Zeichen hängen Agenten nichts mehr an.${named}` +
    ' Sonst: das Neue mit exo_page_create auf eine Unterseite schreiben, oder mit' +
    ' exo_page_section_write einen vorhandenen Abschnitt ändern statt ans Ende anzuhängen.' +
    ' Nichts wurde geschrieben.'
  );
}
