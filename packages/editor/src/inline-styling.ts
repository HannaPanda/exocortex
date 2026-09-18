import { Mark, mergeAttributes } from '@tiptap/core';
import { Subscript } from '@tiptap/extension-subscript';
import { Superscript } from '@tiptap/extension-superscript';
import { Underline } from '@tiptap/extension-underline';

import { type MarkdownExtensionAdapter } from './contract';

/**
 * Named colour tokens for text and background.
 *
 * Colours are stored as *names*, never as CSS values: the design system owns the
 * actual colour (`packages/ui/src/tokens.css`), so a stored document never
 * hardcodes a colour and follows the light/dark theme automatically.
 */
export const TEXT_COLOR_NAMES = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;

export type TextColorName = (typeof TEXT_COLOR_NAMES)[number];

/**
 * The background used for the Markdown highlight syntax (`==Text==`).
 * Obsidian and most Markdown dialects only know one highlight, so this is the
 * colour a plain `==…==` maps to on import and the only one that survives export.
 */
export const MARKDOWN_HIGHLIGHT_BACKGROUND: TextColorName = 'yellow';

export interface TextColorAttributes {
  /** Foreground colour token, `null` or `'default'` means inherit. */
  color?: TextColorName | null;
  /** Background colour token, `null` or `'default'` means none. */
  background?: TextColorName | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textColor: {
      /** Sets the foreground colour of the selection. */
      setTextColor: (color: TextColorName) => ReturnType;
      /** Sets the background colour of the selection. */
      setTextBackground: (background: TextColorName) => ReturnType;
      /** Removes both foreground and background colour from the selection. */
      unsetTextColor: () => ReturnType;
    };
  }
}

function normalizeColor(value: unknown): TextColorName | null {
  if (typeof value !== 'string') return null;
  const candidate = value.toLowerCase();
  if (!(TEXT_COLOR_NAMES as readonly string[]).includes(candidate)) return null;
  return candidate === 'default' ? null : (candidate as TextColorName);
}

/**
 * Foreground and background colour as a single mark.
 *
 * One mark instead of two keeps the common case (Notion's colour picker sets
 * either a text colour or a background) to a single mark in the document and a
 * single span in the DOM.
 */
export const TextColor = Mark.create({
  name: 'textColor',

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) => normalizeColor(element.getAttribute('data-text-color')),
        renderHTML: (attributes) => {
          const color = normalizeColor(attributes.color);
          return color === null ? {} : { 'data-text-color': color };
        },
      },
      background: {
        default: null,
        parseHTML: (element) => normalizeColor(element.getAttribute('data-text-background')),
        renderHTML: (attributes) => {
          const background = normalizeColor(attributes.background);
          return background === null ? {} : { 'data-text-background': background };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-text-color]' }, { tag: 'span[data-text-background]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'exocortex-text-color' }), 0];
  },

  addCommands() {
    return {
      setTextColor:
        (color: TextColorName) =>
        ({ commands }) =>
          color === 'default'
            ? commands.setMark(this.name, { color: null })
            : commands.setMark(this.name, { color }),
      setTextBackground:
        (background: TextColorName) =>
        ({ commands }) =>
          background === 'default'
            ? commands.setMark(this.name, { background: null })
            : commands.setMark(this.name, { background }),
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

/**
 * Markdown adapters for the inline styling marks.
 *
 * `underline`, `superscript` and `subscript` use the widely implemented
 * markdown-it extensions (`++`, `^`, `~`). A text colour has no Markdown
 * representation at all; only a background survives, as `==Text==`
 * (see docs/deviations.md).
 */
export const inlineStylingMarkdownAdapter: MarkdownExtensionAdapter = {
  marks: {
    underline: { open: '++', close: '++', priority: 22 },
    superscript: { open: '^', close: '^', priority: 8 },
    subscript: { open: '~', close: '~', priority: 7 },
    textColor: {
      priority: 25,
      open: (mark) => (normalizeColor(mark.attrs?.background) === null ? '' : '=='),
      close: (mark) => (normalizeColor(mark.attrs?.background) === null ? '' : '=='),
    },
  },
};

/**
 * Superscript without `Strg+.` (issue #81).
 *
 * The application binds `Strg+.` to the context panel, and the editor's keymap
 * runs first, so the keystroke raised text *and* toggled the panel. The panel
 * keeps the key: it is reached constantly and from everywhere, while a
 * superscript is set from the selection toolbar or written as `^hoch^`.
 */
const SuperscriptWithoutShortcut = Superscript.extend({
  addKeyboardShortcuts() {
    return {};
  },
});

/** Tiptap extensions of the inline styling unit. */
export const INLINE_STYLING_EXTENSIONS = [
  Underline,
  SuperscriptWithoutShortcut,
  Subscript,
  TextColor,
];
