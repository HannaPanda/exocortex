import { mergeAttributes, Node } from '@tiptap/core';

import { type BlockCatalogEntry } from './block-catalog';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    breadcrumb: {
      /** Inserts a breadcrumb block at the cursor. */
      insertBreadcrumb: () => ReturnType;
    };
  }
}

/**
 * The DOM attribute the host application puts the ancestor path into, as JSON:
 * `[{ "id": "…", "title": "…", "href": "…" }]`.
 *
 * The path is *not* part of the document: it lives in the page hierarchy, which
 * `packages/editor` neither knows nor may fetch (it has no dependencies, see
 * scripts/dependency-graph.mjs). The host renders the path it already loaded onto
 * the editor element and the node view reads it from there.
 */
export const BREADCRUMB_PATH_ATTRIBUTE = 'data-breadcrumb';

export interface BreadcrumbCrumb {
  id: string;
  title: string;
  href: string;
}

/** Reads and validates the path the host provided. Never throws. */
export function readBreadcrumbPath(element: HTMLElement | null): BreadcrumbCrumb[] {
  const raw = element
    ?.closest(`[${BREADCRUMB_PATH_ATTRIBUTE}]`)
    ?.getAttribute(BREADCRUMB_PATH_ATTRIBUTE);
  if (raw === null || raw === undefined || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCrumb);
  } catch {
    return [];
  }
}

function isCrumb(value: unknown): value is BreadcrumbCrumb {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.href === 'string'
  );
}

/**
 * Breadcrumb block (Notion's "Navigationspfad").
 *
 * Like the table of contents this is derived content: an empty atom in the
 * document, resolved at render time.
 */
export const Breadcrumb = Node.create({
  name: 'breadcrumb',
  group: 'block',
  atom: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'nav[data-breadcrumb-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'nav',
      mergeAttributes(HTMLAttributes, {
        'data-breadcrumb-block': '',
        class: 'exocortex-breadcrumb',
        'aria-label': 'Navigationspfad',
      }),
    ];
  },

  addCommands() {
    return {
      insertBreadcrumb:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },

  addNodeView() {
    return () => {
      const dom = window.document.createElement('nav');
      dom.className = 'exocortex-breadcrumb';
      dom.setAttribute('data-breadcrumb-block', '');
      dom.setAttribute('aria-label', 'Navigationspfad');
      dom.contentEditable = 'false';

      const render = (): void => {
        const path = readBreadcrumbPath(dom);
        dom.replaceChildren();
        if (path.length === 0) {
          const empty = window.document.createElement('span');
          empty.className = 'exocortex-breadcrumb-empty';
          empty.textContent = 'Diese Seite hat keine übergeordneten Seiten.';
          dom.append(empty);
          return;
        }
        path.forEach((crumb, index) => {
          if (index > 0) {
            const divider = window.document.createElement('span');
            divider.setAttribute('aria-hidden', 'true');
            divider.textContent = '/';
            dom.append(divider);
          }
          const anchor = window.document.createElement('a');
          anchor.href = crumb.href;
          anchor.textContent = crumb.title;
          dom.append(anchor);
        });
      };

      // The path is only in the DOM once the node view is attached to it.
      window.requestAnimationFrame(render);

      return {
        dom,
        update: () => {
          render();
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
});

export const breadcrumbMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    breadcrumb: (node, context) => `:::breadcrumb${context.blockIdSuffix(node)}\n:::\n\n`,
  },
  containers: {
    breadcrumb: (_params, context) => {
      context.addNode('breadcrumb');
      return 0;
    },
  },
};

/** Derived content: the path belongs to the tree, not to this page's text. */
export const breadcrumbPlainTextAdapter: PlainTextAdapter = {
  blocks: {
    breadcrumb: () => '',
  },
};

export const breadcrumbBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'breadcrumb',
    label: 'Navigationspfad',
    description: 'Pfad zu dieser Seite in der Hierarchie',
    keywords: ['pfad', 'breadcrumb', 'navigation', 'hierarchie', 'übergeordnet'],
    group: 'advanced',
    icon: 'ChevronRight',
    prompt: 'none',
    turnInto: false,
    run: (editor) => editor.chain().focus().insertBreadcrumb().run(),
    isActive: (editor) => editor.isActive('breadcrumb'),
  },
];
