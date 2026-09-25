import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';

import { type BlockCatalogEntry } from './block-catalog';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';
import { type EditorWords, GERMAN_EDITOR_WORDS } from './editor-words';

/**
 * Draws the disclosure button in the given words; `buildEditorExtensions`
 * hands in the reader's (issue #98).
 */
export function toggleButtonRenderer(
  words: EditorWords['toggle'],
): (props: { element: HTMLElement; isOpen: boolean }) => void {
  return ({ element, isOpen }) => {
    element.className = 'exocortex-toggle-button';
    element.textContent = isOpen ? '▾' : '▸';
    element.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    element.setAttribute('aria-label', isOpen ? words.collapse : words.expand);
  };
}

/**
 * Toggle list (Notion's "Umschaltliste").
 *
 * Uses Tiptap's `Details` trio, configured to persist the open state in the
 * document: in a collaborative editor "is this open" is shared context, and a
 * toggle that reopens for everyone on reload would lose the structure the author
 * created.
 */
export const TOGGLE_EXTENSIONS = [
  Details.configure({
    persist: true,
    HTMLAttributes: { class: 'exocortex-toggle' },
    /*
     * The node view renders a `<div data-type="details">` with an **empty**
     * `<button>`; the native `<details>`/`<summary>` markup only appears in
     * `renderHTML`, which is the HTML export path. So the button has to be given
     * its arrow and, more importantly, its accessible name and state here — an
     * unlabelled disclosure button is unusable with a screen reader.
     */
    renderToggleButton: toggleButtonRenderer(GERMAN_EDITOR_WORDS.toggle),
  }),
  DetailsSummary,
  DetailsContent,
];

/**
 * Markdown adapter.
 *
 * The summary goes into the container's parameter string. Markdown has no
 * notation for a collapsible block, so the Exocortex container syntax carries it
 * (`markdown/container-rule.ts`). Formatting *inside* a summary is not preserved
 * on export; see docs/deviations.md.
 */
export const toggleMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    details: (node, context) => {
      const [summary, content] = node.content ?? [];
      const title = summary === undefined ? '' : context.renderInline(summary).trim();
      const body =
        content === undefined ? '' : context.renderBlockChildren(content).replace(/\n+$/, '');
      const header = `:::toggle${title.length > 0 ? ` ${title}` : ''}${context.blockIdSuffix(node)}`;
      return `${header}\n${body}\n:::\n\n`;
    },
    // Reached only when a summary or content node is serialized on its own.
    detailsSummary: (node, context) => `${context.renderInline(node)}\n\n`,
    detailsContent: (node, context) => context.renderBlockChildren(node),
  },
  containers: {
    toggle: (params, context) => {
      context.openNode('details', { open: true });
      context.addTextNode('detailsSummary', params);
      context.openNode('detailsContent');
      return 2;
    },
  },
};

/** Search projection: the summary is part of the text, the marker is not. */
export const togglePlainTextAdapter: PlainTextAdapter = {
  blocks: {
    details: (node, renderChildren) => renderChildren(node),
    detailsSummary: (node, renderChildren) => `${renderChildren(node)}\n`,
    detailsContent: (node, renderChildren) => renderChildren(node),
  },
};

export const toggleBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'toggle',
    label: 'Umschaltliste',
    description: 'Klappbarer Abschnitt',
    keywords: ['umschalten', 'toggle', 'klappen', 'details', 'ausklappen', 'akkordeon'],
    group: 'lists',
    icon: 'ListTree',
    prompt: 'none',
    turnInto: false,
    run: (editor) =>
      // Not `setDetails()`: that wraps existing content, and it reports success
      // from an empty paragraph while producing nothing, because the node needs
      // both a summary and a content child. Inserting the whole structure works
      // from an empty block and from a filled one alike.
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'details',
          attrs: { open: true },
          content: [
            { type: 'detailsSummary' },
            { type: 'detailsContent', content: [{ type: 'paragraph' }] },
          ],
        })
        .run(),
    isActive: (editor) => editor.isActive('details'),
  },
];
