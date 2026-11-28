import { type DocumentCoverContext } from '@exocortex/contracts';
import { type ProseMirrorNode } from '@exocortex/editor';

/**
 * What a cover may know about its page (issue #224).
 *
 * The person ticks "Kontext aus der Seite" and the image model then hears
 * what the page is about, not what is in it. Three things go over, each cut
 * short:
 *
 * - the title,
 * - the headings as the page's main topics, two to ten of them in the
 *   normal case, because that is how a page names its own themes,
 * - one passage saying what the page is about: the digest's summary when
 *   ADR-028 already wrote one, otherwise the opening of the page's prose.
 *
 * Nothing else. A code block contributes its language and never its code,
 * a picture or a file contributes nothing, and attachment text is never read
 * at all (ADR-030): it lives in the search projection, not in the document,
 * and this function only ever sees the document.
 *
 * Deterministic and free on purpose: a second model call to pick keywords
 * would cost money on every cover and could still invent a topic the page
 * does not have.
 */

/** Topics handed over at most. */
export const MAX_COVER_TOPICS = 10;
/** Characters of one topic. */
const MAX_TOPIC_CHARS = 60;
/** Characters of the summary or the opening. */
export const MAX_COVER_PASSAGE_CHARS = 400;
/** Characters of the title. */
const MAX_TITLE_CHARS = 150;

/**
 * Blocks whose text never goes over: code and formulas. Embedded things (a
 * picture, a file, a database, a transclusion) carry no text of their own in
 * the document and fall out without being named.
 */
const SILENT_BLOCKS = new Set(['codeBlock', 'blockMath']);

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  // Cut at a word where there is one close by, so a topic does not end mid-word.
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()} …`;
}

/**
 * The text of a textblock (a paragraph or a heading). Inline atoms such as a
 * mention or a formula carry their content in attributes and add nothing.
 */
function inlineText(node: ProseMirrorNode): string {
  let text = '';
  for (const child of node.content ?? []) {
    if (child.type === 'text') text += child.text ?? '';
    else if (child.type === 'hardBreak') text += ' ';
  }
  return text;
}

export interface CoverPageMaterial {
  topics: string[];
  /** The page's opening prose, cut short; empty when it has none. */
  opening: string;
}

/** Reads the topics and the opening out of a page's ProseMirror JSON. */
export function readCoverMaterial(document: ProseMirrorNode | null): CoverPageMaterial {
  const topics: string[] = [];
  const seen = new Set<string>();
  const languages: string[] = [];
  let opening = '';

  const addTopic = (raw: string): void => {
    const topic = clip(raw, MAX_TOPIC_CHARS);
    const key = topic.toLocaleLowerCase('de');
    if (topic.length === 0 || seen.has(key) || topics.length >= MAX_COVER_TOPICS) return;
    seen.add(key);
    topics.push(topic);
  };

  const walk = (node: ProseMirrorNode): void => {
    if (node.type === 'heading') {
      const level = typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      // The first three levels name themes; deeper ones name details.
      if (level <= 3) addTopic(inlineText(node));
      return;
    }
    if (SILENT_BLOCKS.has(node.type)) {
      const language = node.attrs?.language;
      if (typeof language === 'string' && language.length > 0 && !languages.includes(language)) {
        languages.push(language);
      }
      return;
    }
    // Prose of every kind ends in paragraphs: a list point, a quote, a callout
    // and a table cell all hold them, so they are where the opening is read.
    if (node.type === 'paragraph') {
      if (opening.length < MAX_COVER_PASSAGE_CHARS) {
        const text = inlineText(node).trim();
        if (text.length > 0) opening = opening.length === 0 ? text : `${opening} ${text}`;
      }
      return;
    }
    for (const child of node.content ?? []) walk(child);
  };

  if (document !== null) walk(document);
  // A code block's language is a topic too: a page of shell scripts is about
  // a terminal even when nobody wrote a heading above them.
  for (const language of languages) addTopic(language);

  return { topics, opening: clip(opening, MAX_COVER_PASSAGE_CHARS) };
}

export interface CoverPromptInput {
  /** What the person asked for; empty when they only asked for the page context. */
  prompt: string;
  title: string;
  /** The digest's summary (ADR-028), or `null` when none was written yet. */
  summary: string | null;
  document: ProseMirrorNode | null;
}

export interface CoverPrompt {
  prompt: string;
  context: DocumentCoverContext;
}

/**
 * The prompt the image model receives when the page context was asked for.
 * `null` when the page offers nothing to draw from and the person wrote
 * nothing either: an empty page has no theme to guess.
 */
export function composeCoverPrompt(input: CoverPromptInput): CoverPrompt | null {
  const material = readCoverMaterial(input.document);
  const title = clip(input.title, MAX_TITLE_CHARS);
  const summary = input.summary === null ? '' : clip(input.summary, MAX_COVER_PASSAGE_CHARS);
  const passage = summary.length > 0 ? summary : material.opening;
  const source: DocumentCoverContext['source'] =
    summary.length > 0 ? 'summary' : material.opening.length > 0 ? 'opening' : 'none';
  const own = input.prompt.trim();

  if (
    own.length === 0 &&
    title.length === 0 &&
    material.topics.length === 0 &&
    passage.length === 0
  ) {
    return null;
  }

  const about = [
    title.length > 0 ? `Die Seite heißt „${title}".` : null,
    passage.length > 0 ? `Worum es geht: ${passage}` : null,
    material.topics.length > 0 ? `Hauptthemen: ${material.topics.join(', ')}.` : null,
  ].filter((line): line is string => line !== null);

  const prompt =
    own.length > 0
      ? [
          own,
          '',
          'Das Bild ist das Titelbild einer Seite und soll zu ihrem Thema passen.',
          ...about,
        ]
      : [
          'Titelbild für eine Seite eines persönlichen Wissensspeichers, passend zu ihrem Thema.',
          ...about,
          // The banner shape and "no lettering" are the generator's framing
          // (`COVER_STYLE_HINT` in packages/ai), added to every prompt alike.
          'Zeige eine Szene oder einen Gegenstand, der dieses Thema verkörpert.',
        ];

  return { prompt: prompt.join('\n'), context: { title, topics: material.topics, source } };
}
