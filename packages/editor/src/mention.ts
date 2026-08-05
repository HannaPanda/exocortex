import { mergeAttributes, Node } from '@tiptap/core';

import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';
import { MENTION_TOKEN } from './markdown/inline-rules';

/** What a mention points at. */
export const MENTION_KINDS = ['page', 'user', 'date'] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

/**
 * The `@` trigger character, shared by the schema and the suggestion UI.
 */
export const MENTION_TRIGGER = '@';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    exocortexMention: {
      /** Inserts a mention at the cursor. */
      insertMention: (attributes: {
        kind: MentionKind;
        label: string;
        id?: string | null;
      }) => ReturnType;
    };
  }
}

function normalizeKind(value: unknown): MentionKind {
  const candidate = typeof value === 'string' ? value.toLowerCase() : '';
  return (MENTION_KINDS as readonly string[]).includes(candidate)
    ? (candidate as MentionKind)
    : 'page';
}

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Inline mention of a page, a person or a date.
 *
 * One node for all three rather than three nodes: they behave identically in the
 * document (an atomic inline chip with a label) and differ only in what they
 * resolve to, which is an attribute, not a type.
 *
 * A page mention stores the page **title**, like the `[[Seite]]` wiki link, so an
 * exported document contains no internal identifiers. The optional `id` is a
 * resolution hint the application may fill in; it is never required to render.
 */
export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      kind: {
        default: 'page',
        parseHTML: (element) => normalizeKind(element.getAttribute('data-mention-kind')),
        renderHTML: (attributes) => ({ 'data-mention-kind': normalizeKind(attributes.kind) }),
      },
      label: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-mention-label') ?? '',
        renderHTML: (attributes) => ({
          'data-mention-label': stringAttribute(attributes.label),
        }),
      },
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-id'),
        renderHTML: (attributes) =>
          typeof attributes.id === 'string' && attributes.id.length > 0
            ? { 'data-mention-id': attributes.id }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention-kind]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'exocortex-mention' }),
      `${MENTION_TRIGGER}${stringAttribute(node.attrs.label)}`,
    ];
  },

  renderText({ node }) {
    return `${MENTION_TRIGGER}${stringAttribute(node.attrs.label)}`;
  },

  addCommands() {
    return {
      insertMention:
        (attributes) =>
        ({ commands }) =>
          commands.insertContent([
            {
              type: this.name,
              attrs: {
                kind: normalizeKind(attributes.kind),
                label: attributes.label,
                id: attributes.id ?? null,
              },
            },
            // A trailing space so the writer keeps typing prose, not inside the chip.
            { type: 'text', text: ' ' },
          ]),
    };
  },
});

/** Markdown notation per kind; see `markdown/inline-rules.ts` for the parser. */
export function serializeMention(kind: MentionKind, label: string): string {
  switch (kind) {
    case 'page':
      return `${MENTION_TRIGGER}[[${label}]]`;
    case 'user':
      return `${MENTION_TRIGGER}[${label}]`;
    case 'date':
      return `${MENTION_TRIGGER}(${label})`;
  }
}

export const mentionMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    mention: (node) =>
      serializeMention(normalizeKind(node.attrs?.kind), stringAttribute(node.attrs?.label)),
  },
  tokens: {
    [MENTION_TOKEN]: (token, context) => {
      context.addNode('mention', {
        kind: normalizeKind(token.info),
        label: token.content,
        id: null,
      });
      return true;
    },
  },
};

/** Search projection: the label is what someone searches for, the `@` is not. */
export const mentionPlainTextAdapter: PlainTextAdapter = {
  blocks: {
    mention: (node) => stringAttribute(node.attrs?.label),
  },
};
