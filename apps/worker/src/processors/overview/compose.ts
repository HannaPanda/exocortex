/**
 * What the model is asked for, and how its answer is read back (issue #53,
 * ADR-028).
 *
 * Kept apart from the processor because this half is pure: material in, prompt
 * out, answer in, two fields out. That is what makes it testable without a
 * provider, a database or a queue, and the parsing is the part that actually
 * breaks when a model is swapped.
 */

/** One child of an overview page, as the prompt sees it. */
export interface CompositionChild {
  title: string;
  /** The child's own digest, or `null` while it has none yet. */
  summary: string | null;
  isOverview: boolean;
  childCount: number;
}

export interface CompositionMaterial {
  title: string;
  /** Path from the workspace root, for a model that has no sidebar. */
  path: readonly string[];
  /** The page's own body. Empty on the overview pages that have none. */
  ownText: string;
  children: readonly CompositionChild[];
}

export interface Composition {
  /** Two or three sentences about the page, for the overview above it. */
  summary: string | null;
  /** The paragraph an overview page opens with. Null when none was asked for. */
  intro: string | null;
}

/** Marker lines the answer is parsed by. Uppercase so a sentence cannot look like one. */
const SUMMARY_MARKER = 'STECKBRIEF:';
const INTRO_MARKER = 'VORSPANN:';

/** Cap on each half, so one runaway answer cannot fill a page. */
export const MAX_SUMMARY_CHARS = 400;
export const MAX_INTRO_CHARS = 1_200;

const STYLE_RULES = [
  'Schreibe auf Deutsch, sachlich und in ganzen Sätzen.',
  'Keine Gedankenstriche: Punkt, Komma, Doppelpunkt oder Klammern.',
  'Keine Überschriften, keine Aufzählungen, kein Markdown.',
  'Keine Werbung und keine Bewertung. Beschreibe, was da ist.',
  'Erfinde nichts. Was im Material nicht steht, kommt nicht vor.',
];

/**
 * The instruction for a page that is not an overview.
 *
 * One job only: say what this page is about, in the form the page above it can
 * quote. The length limit is in the prompt as well as in the parser because a
 * model that has to be cut off mid-sentence produces a digest that reads like a
 * transmission error.
 */
export function digestSystemPrompt(): string {
  return [
    'Du schreibst den Steckbrief einer Seite in einem Wissensspeicher.',
    'Der Steckbrief steht später auf der Übersichtsseite darüber und hilft beim Finden.',
    '',
    'Antworte mit genau einer Zeile:',
    `${SUMMARY_MARKER} <zwei bis drei Sätze>`,
    '',
    'Regeln:',
    '- Sag, worum es auf der Seite geht und wofür man sie aufschlägt.',
    '- Wiederhole den Titel nicht, er steht daneben.',
    '- Höchstens 300 Zeichen.',
    ...STYLE_RULES.map((rule) => `- ${rule}`),
  ].join('\n');
}

/**
 * The instruction for an overview page.
 *
 * Asks for both halves in one call: the paragraph this page opens with, and the
 * steckbrief the page above it quotes. They are one model call because they are
 * the same reading of the same material, and two calls would pay twice for it.
 */
export function overviewSystemPrompt(): string {
  return [
    'Du schreibst den Vorspann einer Übersichtsseite in einem Wissensspeicher.',
    'Die Übersichtsseite sammelt Unterseiten. Der Vorspann sagt, was jemanden dort erwartet.',
    '',
    'Antworte mit genau diesen zwei Zeilen, in dieser Reihenfolge:',
    `${INTRO_MARKER} <drei bis fünf Sätze>`,
    `${SUMMARY_MARKER} <zwei bis drei Sätze>`,
    '',
    'Regeln für den Vorspann:',
    '- Ordne ein, welche Themen unter dieser Seite liegen und wie sie zusammenhängen.',
    '- Nenne die wichtigsten Unterseiten beim Namen, aber zähle nicht alle auf:',
    '  die vollständige Liste steht ohnehin darunter.',
    '- Wenn die Unterseiten nichts verbindet, sag das schlicht, statt eine Klammer zu erfinden.',
    '- Höchstens 900 Zeichen.',
    '',
    'Regeln für den Steckbrief:',
    '- Er steht auf der Übersichtsseite eine Ebene höher. Zwei bis drei Sätze, höchstens 300 Zeichen.',
    '- Er fasst diese Seite samt ihrer Unterseiten zusammen, nicht nur den Vorspann.',
    '',
    'Regeln für beides:',
    ...STYLE_RULES.map((rule) => `- ${rule}`),
  ].join('\n');
}

/** The material of a page that is not an overview: its title, path and text. */
export function renderDigestInput(material: CompositionMaterial): string {
  const lines = [`Titel: ${material.title}`];
  if (material.path.length > 0) lines.push(`Pfad: ${material.path.join(' / ')}`);
  lines.push(
    '',
    'Seiteninhalt:',
    material.ownText.trim().length === 0 ? '(leer)' : material.ownText,
  );
  if (material.children.length > 0) {
    lines.push('', 'Unterseiten:', ...material.children.map((child) => `- ${child.title}`));
  }
  return lines.join('\n');
}

/**
 * The material of an overview page: its children's digests, not their text.
 *
 * A child with no digest yet appears with its title alone. Saying so beats
 * leaving it out: the model can mention that something is there without
 * pretending to know what it says, and the next run fills it in.
 */
export function renderOverviewInput(material: CompositionMaterial): string {
  const lines = [`Titel: ${material.title}`];
  if (material.path.length > 0) lines.push(`Pfad: ${material.path.join(' / ')}`);
  if (material.ownText.trim().length > 0) {
    lines.push(
      '',
      'Eigener Text dieser Seite (von Hand geschrieben, bleibt stehen):',
      material.ownText,
    );
  }
  lines.push('', 'Unterseiten:');
  for (const child of material.children) {
    const facts = [
      child.isOverview ? 'Übersichtsseite' : null,
      child.childCount > 0 ? `${child.childCount} Unterseiten` : null,
    ].filter((entry): entry is string => entry !== null);
    const suffix = facts.length === 0 ? '' : ` (${facts.join(', ')})`;
    lines.push(`- ${child.title}${suffix}: ${child.summary ?? 'noch keine Beschreibung'}`);
  }
  return lines.join('\n');
}

/**
 * Reads the two fields back out of an answer.
 *
 * Forgiving on purpose, because every model gets a format slightly wrong in its
 * own way: a marker may be bold, lower case or followed by a line break, and
 * text may run over several lines until the next marker. What it refuses to do
 * is guess: an answer with no markers at all yields nothing, and nothing is
 * written, because a paragraph of apology stored as a page's digest is worse
 * than an empty digest.
 */
export function parseComposition(answer: string): Composition {
  const sections = new Map<'summary' | 'intro', string[]>();
  let current: 'summary' | 'intro' | null = null;

  for (const rawLine of answer.split('\n')) {
    const line = rawLine.replace(/^[\s*#>-]+/, '');
    const marker = markerOf(line);
    if (marker !== null) {
      current = marker.field;
      sections.set(marker.field, [marker.rest]);
      continue;
    }
    if (current === null) continue;
    sections.get(current)?.push(line);
  }

  return {
    summary: clean(sections.get('summary'), MAX_SUMMARY_CHARS),
    intro: clean(sections.get('intro'), MAX_INTRO_CHARS),
  };
}

function markerOf(line: string): { field: 'summary' | 'intro'; rest: string } | null {
  const upper = line.toUpperCase();
  if (upper.startsWith(SUMMARY_MARKER)) {
    return { field: 'summary', rest: afterMarker(line, SUMMARY_MARKER) };
  }
  if (upper.startsWith(INTRO_MARKER)) {
    return { field: 'intro', rest: afterMarker(line, INTRO_MARKER) };
  }
  return null;
}

/**
 * What follows a marker, without the punctuation a model wrapped it in.
 *
 * `**VORSPANN:**` leaves two asterisks behind after the colon, and they would
 * otherwise become the first characters of the paragraph on the page.
 */
function afterMarker(line: string, marker: string): string {
  return line.slice(marker.length).replace(/^[*_:\s]+/, '');
}

/**
 * One block of answer lines into one paragraph.
 *
 * Line breaks inside a section are the model's formatting, not the author's
 * intent, so they become spaces: the composition is rendered as a paragraph and
 * a hard break in the middle of it only looks like a mistake.
 */
function clean(lines: string[] | undefined, limit: number): string | null {
  if (lines === undefined) return null;
  const text = lines
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^["„]|["“]$/g, '')
    .trim();
  if (text.length === 0) return null;
  if (text.length <= limit) return text;
  // Cut at the last sentence that fits rather than mid-word: the limit exists
  // to bound the text, not to produce an ellipsis.
  const cut = text.slice(0, limit);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return lastStop > limit / 2 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()} …`;
}
