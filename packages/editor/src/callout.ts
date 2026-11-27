import { mergeAttributes, Node } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import { type Transaction } from '@tiptap/pm/state';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { type MarkdownExtensionAdapter, type ProseMirrorNode } from './contract';
import { type EditorWords, GERMAN_EDITOR_WORDS } from './editor-words';
import { TEXT_COLOR_NAMES, type TextColorName } from './inline-styling';

/**
 * The callout ("Hinweis", issue #306): one box with a symbol, an optional
 * heading and a frame colour.
 *
 * Until #306 a callout was one of five variants (`info`, `note`, `success`,
 * `warning`, `danger`) that differed in nothing but the colour of the frame,
 * so for anybody who cannot tell the colours apart they were five identical
 * boxes. Now the meaning is carried by the symbol and the heading, both of
 * which are text a screen reader reads and a colour-blind reader sees; the
 * colour is the writer's emphasis and never the only carrier of meaning
 * (WCAG 1.4.1).
 *
 * The colours are the editor's content colours (`TEXT_COLOR_NAMES`), the same
 * named palette a text run is painted with, stored by name so a document never
 * holds a CSS value. `null` is the plain frame.
 *
 * `variant` is the old attribute. It stays in the schema, read only, so that
 * a state written before #306 (a snapshot, a browser that has not reloaded
 * yet, a page nobody opened since) still shows the symbol and colour its
 * variant stood for. `resolveCallout` is the one place that reads it;
 * schema version 6 and `migrateCalloutsInYjsDoc` replace it with the explicit
 * attributes.
 */

/** The variants every callout before issue #306 was written with. */
export const LEGACY_CALLOUT_VARIANTS = ['info', 'note', 'success', 'warning', 'danger'] as const;

/** A frame colour; `default` is the plain frame and is stored as `null`. */
export type CalloutColor = TextColorName;

/** The colours a frame can take, in menu order. Same names as the text colours. */
export const CALLOUT_COLORS: readonly CalloutColor[] = TEXT_COLOR_NAMES;

/** The symbol a new callout starts with: the light bulb, as in Notion. */
export const DEFAULT_CALLOUT_EMOJI = '💡';

/** The longest symbol accepted; a flag with a modifier sequence is about 14. */
const MAX_EMOJI_LENGTH = 32;

/** The longest heading accepted; a heading is a few words, not a paragraph. */
const MAX_TITLE_LENGTH = 200;

/** What a callout looks like once the legacy variant has been read. */
export interface ResolvedCallout {
  emoji: string;
  title: string | null;
  /** `null` for the plain frame. */
  color: CalloutColor | null;
}

export interface CalloutCommandAttributes {
  emoji?: string | null;
  title?: string | null;
  color?: CalloutColor | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Wraps the current selection in a callout. */
      setCallout: (attributes?: CalloutCommandAttributes) => ReturnType;
      /** Toggles a callout around the current selection. */
      toggleCallout: (attributes?: CalloutCommandAttributes) => ReturnType;
      /** Lifts the current block out of its callout. */
      unsetCallout: () => ReturnType;
    };
  }
}

/**
 * The colour and the fallback symbol a Markdown keyword stands for.
 *
 * The keyword is what goes between `[!` and `]`. It covers three dialects so a
 * file from any of them comes in with the meaning it had there: eXocortex's own
 * five variants (and therefore every callout written before #306), GitHub's
 * alerts and Obsidian's callout types. The symbol only applies when the header
 * names none; an eXocortex export always does.
 */
interface CalloutKeyword {
  color: CalloutColor | null;
  emoji: string;
}

const CALLOUT_KEYWORDS: Readonly<Record<string, CalloutKeyword>> = {
  // eXocortex before #306: the five variants.
  note: { color: null, emoji: '📝' },
  info: { color: 'blue', emoji: 'ℹ️' },
  success: { color: 'green', emoji: '✅' },
  warning: { color: 'yellow', emoji: '⚠️' },
  danger: { color: 'red', emoji: '🚨' },
  // GitHub's alerts (`> [!NOTE]` and friends).
  tip: { color: 'green', emoji: '💡' },
  important: { color: 'purple', emoji: '❗' },
  caution: { color: 'red', emoji: '🚨' },
  // Obsidian's further callout types and their aliases.
  abstract: { color: 'blue', emoji: '📋' },
  summary: { color: 'blue', emoji: '📋' },
  tldr: { color: 'blue', emoji: '📋' },
  todo: { color: 'blue', emoji: '☑️' },
  hint: { color: 'green', emoji: '💡' },
  check: { color: 'green', emoji: '✅' },
  done: { color: 'green', emoji: '✅' },
  question: { color: 'yellow', emoji: '❓' },
  help: { color: 'yellow', emoji: '❓' },
  faq: { color: 'yellow', emoji: '❓' },
  attention: { color: 'yellow', emoji: '⚠️' },
  failure: { color: 'red', emoji: '❌' },
  fail: { color: 'red', emoji: '❌' },
  missing: { color: 'red', emoji: '❌' },
  error: { color: 'red', emoji: '⛔' },
  bug: { color: 'red', emoji: '🐛' },
  example: { color: 'purple', emoji: '📎' },
  quote: { color: 'gray', emoji: '💬' },
  cite: { color: 'gray', emoji: '💬' },
};

/**
 * The keyword a colour is exported under.
 *
 * The four colours with a conventional meaning keep the keyword other tools
 * colour the same way (Obsidian draws `[!warning]` yellow); the others are
 * written as their own name, which Obsidian shows as a plain callout and which
 * comes back here as that colour.
 */
const EXPORT_KEYWORDS: Readonly<Partial<Record<CalloutColor, string>>> = {
  blue: 'info',
  green: 'success',
  yellow: 'warning',
  red: 'danger',
};

/** The keyword of the plain frame. */
const PLAIN_KEYWORD = 'note';

/**
 * One emoji at the start of a string: a flag, a keycap, or a pictograph with
 * its variation selector, skin tone and zero-width-joined companions.
 */
const LEADING_EMOJI_PATTERN =
  /^(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?(?:‍\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?)*)/u;

/** A stored symbol, or `null` when there is none worth showing. */
export function normalizeCalloutEmoji(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EMOJI_LENGTH) return null;
  return trimmed;
}

/** A stored heading, or `null` for none. One line, never empty. */
export function normalizeCalloutTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_TITLE_LENGTH);
}

/** A stored colour, or `null` for the plain frame (and anything unknown). */
export function normalizeCalloutColor(value: unknown): CalloutColor | null {
  if (typeof value !== 'string') return null;
  const candidate = value.toLowerCase();
  if (candidate === 'default') return null;
  return (CALLOUT_COLORS as readonly string[]).includes(candidate)
    ? (candidate as CalloutColor)
    : null;
}

/** What a keyword means here: a known one, a colour name, or the plain frame. */
function readKeyword(keyword: string): CalloutKeyword {
  const lower = keyword.toLowerCase();
  const known = CALLOUT_KEYWORDS[lower];
  if (known !== undefined) return known;
  return { color: normalizeCalloutColor(lower), emoji: DEFAULT_CALLOUT_EMOJI };
}

/**
 * The callout's symbol, heading and colour, with an old variant read.
 *
 * Every reader of a callout goes through this rather than through the raw
 * attributes, because a state from before #306 carries `variant` and nothing
 * else. An explicit attribute always wins over the variant.
 */
export function resolveCallout(
  attrs: Readonly<Record<string, unknown>> | undefined,
): ResolvedCallout {
  const legacy =
    typeof attrs?.variant === 'string' && attrs.variant.length > 0
      ? readKeyword(attrs.variant)
      : null;
  const emoji = normalizeCalloutEmoji(attrs?.emoji) ?? legacy?.emoji ?? DEFAULT_CALLOUT_EMOJI;
  const explicitColor = attrs?.color;
  const color =
    typeof explicitColor === 'string' && explicitColor.length > 0
      ? normalizeCalloutColor(explicitColor)
      : (legacy?.color ?? null);
  return { emoji, title: normalizeCalloutTitle(attrs?.title), color };
}

/**
 * The attributes a callout is stored with after a change.
 *
 * The resolved values are written out in full and `variant` is cleared, so a
 * callout somebody touches leaves the legacy form behind: changing only the
 * colour of an old warning keeps its warning sign instead of falling back to
 * the light bulb.
 */
export function calloutAttributes(
  current: Readonly<Record<string, unknown>> | undefined,
  change: CalloutCommandAttributes = {},
): Record<string, unknown> {
  const resolved = resolveCallout(current);
  const emoji =
    change.emoji === undefined
      ? resolved.emoji
      : (normalizeCalloutEmoji(change.emoji) ?? DEFAULT_CALLOUT_EMOJI);
  const title = change.title === undefined ? resolved.title : normalizeCalloutTitle(change.title);
  const color = change.color === undefined ? resolved.color : normalizeCalloutColor(change.color);
  return { ...current, emoji, title, color, variant: null };
}

/**
 * Changes the callout at `pos` in `tr`. Returns `false` when no callout
 * stands there (a collaborator may have removed it while a menu was open).
 */
export function updateCalloutAt(
  tr: Transaction,
  pos: number,
  change: CalloutCommandAttributes,
): boolean {
  const node = tr.doc.nodeAt(pos);
  if (node?.type.name !== 'callout') return false;
  tr.setNodeMarkup(pos, undefined, calloutAttributes(node.attrs, change));
  return true;
}

/** The DOM event a callout's symbol or heading sends when it is pressed. */
export const CALLOUT_EDIT_EVENT = 'exocortex:callout-edit';

/** What the edit event carries: where the callout is and what was pressed. */
export interface CalloutEditEventDetail {
  pos: number;
  /** The part that was pressed, so the menu can start there. */
  part: 'emoji' | 'title';
  /** The symbol's button, which the menu is anchored to. */
  anchor: HTMLElement;
}

/** The DOM of the parts outside the editable content, shared by render and node view. */
const CLASSES = {
  root: 'exocortex-callout',
  emoji: 'exocortex-callout-emoji',
  body: 'exocortex-callout-body',
  title: 'exocortex-callout-title',
  content: 'exocortex-callout-content',
} as const;

/** The attributes that only change how the box looks, which the node view patches in place. */
const PAINTED_ATTRIBUTES = new Set(['emoji', 'title', 'color', 'variant']);

function onlyPaintChanged(previous: PmNode, next: PmNode): boolean {
  if (previous.type !== next.type) return false;
  const keys = new Set([...Object.keys(previous.attrs), ...Object.keys(next.attrs)]);
  for (const key of keys) {
    if (PAINTED_ATTRIBUTES.has(key)) continue;
    if (previous.attrs[key] !== next.attrs[key]) return false;
  }
  return true;
}

/**
 * Custom eXocortex block node, and the reference for one that renders parts of
 * its own around editable content.
 *
 * Markdown syntax (Obsidian-compatible, `calloutMarkdownAdapter`):
 *
 *   > [!warning] ⚠️ Achtung
 *   > Inhalt der Box
 */
export const Callout = Node.create<{ words: EditorWords }>({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addOptions() {
    return { words: GERMAN_EDITOR_WORDS };
  },

  addAttributes() {
    return {
      emoji: {
        default: null,
        parseHTML: (element) => normalizeCalloutEmoji(element.getAttribute('data-emoji')),
        // Rendered by the node itself, resolved, in `renderHTML` below.
        renderHTML: () => ({}),
      },
      title: {
        default: null,
        parseHTML: (element) => normalizeCalloutTitle(element.getAttribute('data-title')),
        renderHTML: () => ({}),
      },
      color: {
        default: null,
        parseHTML: (element) => normalizeCalloutColor(element.getAttribute('data-color')),
        renderHTML: () => ({}),
      },
      /** Read only: the variant of a callout written before #306. */
      variant: {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute('data-variant');
          return value !== null && value.length > 0 ? value.toLowerCase() : null;
        },
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'aside[data-callout]',
        // What `renderHTML` writes keeps the symbol and the heading outside the
        // content; HTML from before #306 (and from elsewhere) has the blocks
        // directly inside the aside.
        contentElement: (element) =>
          (element instanceof HTMLElement
            ? element.querySelector<HTMLElement>(`:scope > .${CLASSES.body} > .${CLASSES.content}`)
            : null) ?? (element as HTMLElement),
      },
    ];
  },

  /**
   * The static rendering: the clipboard, an HTML export, a server render.
   *
   * The symbol and the heading are written as text in front of the content,
   * so a box pasted into a mail or a word processor still says what it is.
   */
  renderHTML({ node, HTMLAttributes }) {
    const { emoji, title, color } = resolveCallout(node.attrs);
    return [
      'aside',
      mergeAttributes(HTMLAttributes, {
        'data-callout': '',
        'data-emoji': emoji,
        ...(title === null ? {} : { 'data-title': title }),
        ...(color === null ? {} : { 'data-color': color }),
        class: CLASSES.root,
      }),
      ['span', { class: CLASSES.emoji }, emoji],
      [
        'div',
        { class: CLASSES.body },
        ...(title === null ? [] : [['strong', { class: CLASSES.title }, title]]),
        ['div', { class: CLASSES.content }, 0],
      ],
    ];
  },

  /**
   * Plain DOM, so `getExocortexSchema()` keeps working without a DOM on the
   * server (docs/editor-extensions.md). The symbol is a button and the heading
   * a pressable label; both announce themselves with `CALLOUT_EDIT_EVENT` and
   * the web layer opens the menu, because a menu is React and this package is
   * not. A change of symbol, heading or colour is painted in place rather than
   * by rebuilding the box, so the menu's anchor survives the change it makes.
   */
  addNodeView() {
    const words = this.options.words;
    return ({ node, getPos, editor, HTMLAttributes }) => {
      const dom = document.createElement('aside');
      for (const [name, value] of Object.entries(HTMLAttributes)) {
        if (value !== null && value !== undefined) dom.setAttribute(name, String(value));
      }
      dom.setAttribute('data-callout', '');
      // A note, not the complementary landmark an `aside` would be: a page
      // with five boxes must not announce five landmarks.
      dom.setAttribute('role', 'note');
      dom.classList.add(CLASSES.root);

      const emoji = document.createElement('button');
      emoji.type = 'button';
      emoji.className = CLASSES.emoji;
      emoji.contentEditable = 'false';
      emoji.setAttribute('data-callout-emoji', '');
      // Reached from the text with Tab (the web layer), never by tabbing
      // through the page: in a contenteditable every box would otherwise be a
      // stop on the way out of the editor.
      emoji.tabIndex = -1;

      const body = document.createElement('div');
      body.className = CLASSES.body;
      const title = document.createElement('div');
      title.className = CLASSES.title;
      title.contentEditable = 'false';
      title.setAttribute('data-callout-title', '');
      const content = document.createElement('div');
      content.className = CLASSES.content;
      body.append(title, content);
      dom.append(emoji, body);

      let current = node;
      const paint = (next: PmNode): void => {
        const resolved = resolveCallout(next.attrs);
        emoji.textContent = resolved.emoji;
        const label = words.callout.edit(resolved.emoji);
        emoji.setAttribute('aria-label', label);
        emoji.title = label;
        emoji.disabled = !editor.isEditable;
        dom.setAttribute('data-emoji', resolved.emoji);
        if (resolved.color === null) dom.removeAttribute('data-color');
        else dom.setAttribute('data-color', resolved.color);
        title.textContent = resolved.title ?? '';
        title.hidden = resolved.title === null;
      };
      paint(node);

      const announce = (part: CalloutEditEventDetail['part']): void => {
        if (!editor.isEditable || typeof getPos !== 'function') return;
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const detail: CalloutEditEventDetail = { pos, part, anchor: emoji };
        dom.dispatchEvent(new CustomEvent(CALLOUT_EDIT_EVENT, { bubbles: true, detail }));
      };
      emoji.addEventListener('click', (event) => {
        event.preventDefault();
        announce('emoji');
      });
      emoji.addEventListener('keydown', (event) => {
        // Back to the text, the way the code block's bar does it (#304).
        if (event.key === 'Escape' || (event.key === 'Tab' && event.shiftKey)) {
          event.preventDefault();
          editor.commands.focus();
        }
      });
      title.addEventListener('click', (event) => {
        event.preventDefault();
        announce('title');
      });

      return {
        dom,
        contentDOM: content,
        update: (next) => {
          if (!onlyPaintChanged(current, next)) return false;
          current = next;
          paint(next);
          return true;
        },
        // The symbol and the heading are the box's own controls: ProseMirror
        // must neither place a caret on a press there nor read their DOM.
        stopEvent: (event) =>
          event.target instanceof globalThis.Node &&
          (emoji.contains(event.target) || title.contains(event.target)),
        ignoreMutation: (mutation) =>
          mutation.type !== 'selection' && !content.contains(mutation.target),
      };
    };
  },

  addCommands() {
    return {
      setCallout:
        (attributes?: CalloutCommandAttributes) =>
        ({ commands }) =>
          commands.wrapIn(this.name, calloutAttributes(undefined, attributes)),
      toggleCallout:
        (attributes?: CalloutCommandAttributes) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, calloutAttributes(undefined, attributes)),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});

/** The header of a callout in Markdown, without its leading `> `. */
export function calloutMarkdownHeader(
  attrs: Readonly<Record<string, unknown>> | undefined,
): string {
  const { emoji, title, color } = resolveCallout(attrs);
  const keyword = color === null ? PLAIN_KEYWORD : (EXPORT_KEYWORDS[color] ?? color);
  return `[!${keyword}] ${emoji}${title === null ? '' : ` ${title}`}`;
}

/** Markdown adapter for the callout node. */
export const calloutMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    callout: (node, context) => {
      const header = `> ${calloutMarkdownHeader(node.attrs)}${context.blockIdSuffix(node)}`;
      const body = context.renderBlockChildren(node);
      const quoted = body
        .replace(/\n+$/, '')
        .split('\n')
        .map((line) => (line.length > 0 ? `> ${line}` : '>'))
        .join('\n');
      return `${header}\n${quoted}\n\n`;
    },
  },
};

/**
 * The attributes a Markdown callout header stands for.
 *
 * `keyword` is what stood between `[!` and `]`, `text` what followed it on the
 * line (with any block id already removed). A leading emoji is the symbol and
 * the rest the heading; without one the keyword's own symbol applies, which is
 * how `> [!warning] Titel` from before #306 keeps its warning sign.
 */
export function calloutAttributesFromHeader(
  keyword: string,
  text: string,
): { emoji: string; title: string | null; color: CalloutColor | null } {
  const meaning = readKeyword(keyword);
  const trimmed = text.trim();
  const match = LEADING_EMOJI_PATTERN.exec(trimmed);
  const emoji = match === null ? meaning.emoji : match[0];
  const rest = match === null ? trimmed : trimmed.slice(match[0].length);
  return { emoji, title: normalizeCalloutTitle(rest), color: meaning.color };
}

/** Type guard used by the Markdown serializer. */
export function isCalloutNode(node: ProseMirrorNode): boolean {
  return node.type === 'callout';
}

/** Re-exported so the serializer can reference the attribute name. */
export const CALLOUT_BLOCK_ID_ATTRIBUTE = BLOCK_ID_ATTRIBUTE;
