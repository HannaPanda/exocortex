import { mergeAttributes, Node } from '@tiptap/core';
import { type Node as PmNode } from '@tiptap/pm/model';
import { type Transaction } from '@tiptap/pm/state';

import { type BlockCatalogEntry } from './block-catalog';
import { BLOCK_ID_ATTRIBUTE } from './block-id';
import {
  type MarkdownExtensionAdapter,
  type PlainTextAdapter,
  type ProseMirrorDocument,
  type ProseMirrorNode,
} from './contract';
import { type EditorWords, GERMAN_EDITOR_WORDS } from './editor-words';

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
  /**
   * Indentation step, 0 for the page's top heading level (issue #228).
   *
   * Counted over the levels the page really uses, the way the floating outline
   * counts them (#194): a page whose headings start at H2 does not open with an
   * indented list, and an H4 under an H2 is one step in when no H3 exists.
   */
  depth: number;
  text: string;
  /** Stable block id of the heading, used as the anchor. */
  blockId: string | null;
}

/** A heading as either reader sees it, before the depth is known. */
interface HeadingFound {
  level: number;
  text: string;
  blockId: string | null;
}

/**
 * The entries a table of contents lists, from the headings in document order.
 *
 * A heading without text is left out: it is a line somebody is about to type
 * into, and an empty entry would be an anchor nobody can see or click.
 */
function toOutline(headings: readonly HeadingFound[]): OutlineEntry[] {
  const listed = headings.filter((heading) => heading.text.length > 0);
  const levels = [...new Set(listed.map((heading) => heading.level))].sort((a, b) => a - b);
  return listed.map((heading) => ({ ...heading, depth: levels.indexOf(heading.level) }));
}

function headingLevel(value: unknown): number {
  return typeof value === 'number' ? value : 1;
}

function headingBlockId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Reads the heading outline of a document.
 *
 * Anchors are the stable block ids, never positions or slugs: a slug changes
 * when the heading is edited, an id does not (ADR-003).
 */
export function readOutline(doc: PmNode): OutlineEntry[] {
  const headings: HeadingFound[] = [];
  doc.descendants((node) => {
    if (node.type.name !== 'heading') return true;
    headings.push({
      level: headingLevel(node.attrs.level),
      text: node.textContent.trim(),
      blockId: headingBlockId(node.attrs[BLOCK_ID_ATTRIBUTE]),
    });
    // Headings contain only inline content, so there is nothing to descend into.
    return false;
  });
  return toOutline(headings);
}

function jsonText(node: ProseMirrorNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(jsonText).join('');
}

/**
 * The same outline from a document as JSON, for a reader that has no editor:
 * the page behind a public link renders the block from it (issue #228).
 */
export function readOutlineFromJson(document: ProseMirrorDocument): OutlineEntry[] {
  const headings: HeadingFound[] = [];
  const walk = (nodes: readonly ProseMirrorNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (node.type === 'heading') {
        headings.push({
          level: headingLevel(node.attrs?.level),
          text: jsonText(node).trim(),
          blockId: headingBlockId(node.attrs?.[BLOCK_ID_ATTRIBUTE]),
        });
        continue;
      }
      walk(node.content);
    }
  };
  walk(document.content);
  return toOutline(headings);
}

/** Whether two outlines draw the same list, so a redraw can be skipped. */
function outlineKey(entries: readonly OutlineEntry[]): string {
  return JSON.stringify(entries.map((entry) => [entry.depth, entry.text, entry.blockId]));
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
export const TableOfContents = Node.create<{ words: EditorWords }>({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,

  addOptions() {
    return { words: GERMAN_EDITOR_WORDS };
  },

  parseHTML() {
    return [{ tag: 'nav[data-toc]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'nav',
      mergeAttributes(HTMLAttributes, {
        'data-toc': '',
        class: 'exocortex-toc',
        'aria-label': this.options.words.tableOfContents.label,
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
    const words = this.options.words.tableOfContents;
    return ({ editor }) => {
      const dom = window.document.createElement('nav');
      dom.className = 'exocortex-toc';
      dom.setAttribute('data-toc', '');
      dom.setAttribute('aria-label', words.label);
      // The outline is generated content; typing inside it makes no sense.
      dom.contentEditable = 'false';

      let drawn: string | null = null;
      const render = (): void => {
        const entries = readOutline(editor.state.doc);
        const key = outlineKey(entries);
        if (key === drawn) return;
        drawn = key;
        dom.replaceChildren();
        if (entries.length === 0) {
          const empty = window.document.createElement('p');
          empty.className = 'exocortex-toc-empty';
          empty.textContent = words.empty;
          dom.append(empty);
          return;
        }
        const list = window.document.createElement('ol');
        for (const entry of entries) {
          const item = window.document.createElement('li');
          item.dataset.level = String(entry.level);
          item.dataset.depth = String(Math.min(entry.depth, 3));
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

      // ProseMirror only asks a node view to update when its own node or its
      // decorations changed. This node never changes: a heading renamed three
      // paragraphs further down leaves it identical, so the view would keep
      // the old list. Every change of the document is a reason to look again,
      // whether it was typed here or arrived from a collaborator.
      const onTransaction = ({ transaction }: { transaction: Transaction }): void => {
        if (transaction.docChanged) render();
      };
      editor.on('transaction', onTransaction);

      return {
        dom,
        update: (node) => {
          if (node.type.name !== this.name) return false;
          render();
          return true;
        },
        ignoreMutation: () => true,
        destroy: () => {
          editor.off('transaction', onTransaction);
        },
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
    keywords: [
      'inhaltsverzeichnis',
      'inhalt',
      'verzeichnis',
      'toc',
      'gliederung',
      'übersicht',
      'überschriften',
      'contents',
      'outline',
    ],
    group: 'advanced',
    icon: 'TableOfContents',
    prompt: 'none',
    turnInto: false,
    run: (editor) => editor.chain().focus().insertTableOfContents().run(),
    isActive: (editor) => editor.isActive('tableOfContents'),
  },
];
