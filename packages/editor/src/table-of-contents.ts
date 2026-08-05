import { mergeAttributes, Node } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';

import { type BlockCatalogEntry } from './block-catalog';
import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tableOfContents: {
      /** Inserts a table of contents at the cursor. */
      insertTableOfContents: () => ReturnType;
    };
  }
}

/** One entry of the derived outline. */
export interface OutlineEntry {
  level: number;
  text: string;
  /** Stable block id of the heading, used as the anchor. */
  blockId: string | null;
}

/**
 * Reads the heading outline of a document.
 *
 * Exported because the node view uses it and so can a reader view later. Anchors
 * are the stable block ids, never positions or slugs: a slug changes when the
 * heading is edited, an id does not (ADR-003).
 */
export function readOutline(doc: PmNode): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'heading') return true;
    const level = typeof node.attrs.level === 'number' ? node.attrs.level : 1;
    const blockId = node.attrs[BLOCK_ID_ATTRIBUTE];
    entries.push({
      level,
      text: node.textContent.trim(),
      blockId: typeof blockId === 'string' && blockId.length > 0 ? blockId : null,
    });
    // Headings contain only inline content, so there is nothing to descend into.
    return false;
  });
  return entries;
}

/**
 * Table of contents (Notion's "Inhaltsverzeichnis").
 *
 * An empty, atomic node: the outline is *derived* from the document's headings on
 * every render, never stored. A stored copy would be a second source of truth that
 * silently goes stale, which is the same reason Markdown is not canonical
 * (ADR-007).
 *
 * The node view is plain DOM rather than React so `packages/editor` stays usable
 * headlessly on the server (docs/editor-extensions.md).
 */
export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'nav[data-toc]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'nav',
      mergeAttributes(HTMLAttributes, {
        'data-toc': '',
        class: 'exocortex-toc',
        'aria-label': 'Inhaltsverzeichnis',
      }),
    ];
  },

  addCommands() {
    return {
      insertTableOfContents:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },

  addNodeView() {
    return ({ editor }) => {
      const dom = window.document.createElement('nav');
      dom.className = 'exocortex-toc';
      dom.setAttribute('data-toc', '');
      dom.setAttribute('aria-label', 'Inhaltsverzeichnis');
      // The outline is generated content; typing inside it makes no sense.
      dom.contentEditable = 'false';

      const render = (): void => {
        const entries = readOutline(editor.state.doc);
        dom.replaceChildren();
        if (entries.length === 0) {
          const empty = window.document.createElement('p');
          empty.className = 'exocortex-toc-empty';
          empty.textContent = 'Noch keine Überschriften auf dieser Seite.';
          dom.append(empty);
          return;
        }
        const list = window.document.createElement('ol');
        for (const entry of entries) {
          const item = window.document.createElement('li');
          item.dataset.level = String(entry.level);
          if (entry.blockId === null) {
            item.textContent = entry.text;
          } else {
            const anchor = window.document.createElement('a');
            anchor.href = `#${entry.blockId}`;
            anchor.textContent = entry.text;
            item.append(anchor);
          }
          list.append(item);
        }
        dom.append(list);
      };

      render();

      return {
        dom,
        // Any transaction may have added or renamed a heading.
        update: () => {
          render();
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
});

export const tableOfContentsMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    tableOfContents: (node, context) => `:::toc${context.blockIdSuffix(node)}\n:::\n\n`,
  },
  containers: {
    toc: (_params, context) => {
      context.addNode('tableOfContents');
      return 0;
    },
  },
};

/** Derived content is not indexed: the headings themselves already are. */
export const tableOfContentsPlainTextAdapter: PlainTextAdapter = {
  blocks: {
    tableOfContents: () => '',
  },
};

export const tableOfContentsBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'table-of-contents',
    label: 'Inhaltsverzeichnis',
    description: 'Übersicht aller Überschriften der Seite',
    keywords: ['inhaltsverzeichnis', 'inhalt', 'toc', 'gliederung', 'übersicht'],
    group: 'advanced',
    icon: 'ListTodo',
    prompt: 'none',
    turnInto: false,
    run: (editor) => editor.chain().focus().insertTableOfContents().run(),
    isActive: (editor) => editor.isActive('tableOfContents'),
  },
];
