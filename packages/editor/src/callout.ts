import { mergeAttributes, Node } from '@tiptap/core';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { type MarkdownExtensionAdapter, type ProseMirrorNode } from './contract';

export const CALLOUT_VARIANTS = ['info', 'note', 'success', 'warning', 'danger'] as const;
export type CalloutVariant = (typeof CALLOUT_VARIANTS)[number];

export const DEFAULT_CALLOUT_VARIANT: CalloutVariant = 'info';

export interface CalloutCommandAttributes {
  variant?: CalloutVariant;
  title?: string | null;
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

function normalizeVariant(value: unknown): CalloutVariant {
  const candidate = typeof value === 'string' ? value.toLowerCase() : '';
  return (CALLOUT_VARIANTS as readonly string[]).includes(candidate)
    ? (candidate as CalloutVariant)
    : DEFAULT_CALLOUT_VARIANT;
}

/**
 * Custom Exocortex block node. Exists to prove the extension system end to end:
 * schema, rendering, keyboard input rule, Markdown import and Markdown export
 * are all contributed by this single unit.
 *
 * Markdown syntax (Obsidian-compatible):
 *
 *   > [!warning] Optionaler Titel
 *   > Inhalt der Box
 */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: DEFAULT_CALLOUT_VARIANT,
        parseHTML: (element) => normalizeVariant(element.getAttribute('data-variant')),
        renderHTML: (attributes) => ({ 'data-variant': normalizeVariant(attributes.variant) }),
      },
      title: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-title'),
        renderHTML: (attributes) =>
          typeof attributes.title === 'string' && attributes.title.length > 0
            ? { 'data-title': attributes.title }
            : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'aside',
      mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'exocortex-callout' }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (attributes?: CalloutCommandAttributes) =>
        ({ commands }) =>
          commands.wrapIn(this.name, {
            variant: normalizeVariant(attributes?.variant),
            title: attributes?.title ?? null,
          }),
      toggleCallout:
        (attributes?: CalloutCommandAttributes) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, {
            variant: normalizeVariant(attributes?.variant),
            title: attributes?.title ?? null,
          }),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});

/** Markdown adapter for the callout node. */
export const calloutMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    callout: (node, context) => {
      const variant = normalizeVariant(node.attrs?.variant);
      const title = typeof node.attrs?.title === 'string' ? node.attrs.title : '';
      const header = `> [!${variant}]${title.length > 0 ? ` ${title}` : ''}${context.blockIdSuffix(node)}`;
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
 * Recognizes the callout header inside a blockquote during Markdown import.
 * Returns `null` when the blockquote is a normal quote.
 */
export function parseCalloutHeader(
  firstLine: string,
): { variant: CalloutVariant; title: string | null; rest: string } | null {
  const match = /^\[!([A-Za-z]+)\](?:\s+(.*))?$/.exec(firstLine.trim());
  if (match === null) return null;
  const variant = normalizeVariant(match[1]);
  const title = match[2] !== undefined && match[2].trim().length > 0 ? match[2].trim() : null;
  return { variant, title, rest: '' };
}

/** Type guard used by the Markdown serializer. */
export function isCalloutNode(node: ProseMirrorNode): boolean {
  return node.type === 'callout';
}

/** Re-exported so the serializer can reference the attribute name. */
export const CALLOUT_BLOCK_ID_ATTRIBUTE = BLOCK_ID_ATTRIBUTE;
