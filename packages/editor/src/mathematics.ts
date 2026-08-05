import { BlockMath, InlineMath } from '@tiptap/extension-mathematics';

import { type BlockCatalogEntry } from './block-catalog';
import { type MarkdownExtensionAdapter, type PlainTextAdapter } from './contract';
import { MATH_BLOCK_TOKEN, MATH_INLINE_TOKEN } from './markdown/container-rule';

/**
 * LaTeX mathematics, inline (`$…$`) and as a block (`$$…$$`).
 *
 * The nodes store the LaTeX source, never rendered output: KaTeX output is a
 * derived representation, and storing it would freeze one renderer version into
 * the document. Rendering happens in the node view, in the browser.
 */
export const MATHEMATICS_EXTENSIONS = [
  InlineMath.configure({ katexOptions: { throwOnError: false } }),
  BlockMath.configure({ katexOptions: { throwOnError: false, displayMode: true } }),
];

function latexOf(attrs: Record<string, unknown> | undefined): string {
  return typeof attrs?.latex === 'string' ? attrs.latex : '';
}

export const mathematicsMarkdownAdapter: MarkdownExtensionAdapter = {
  blocks: {
    blockMath: (node, context) =>
      `$$${context.blockIdSuffix(node)}\n${latexOf(node.attrs)}\n$$\n\n`,
    inlineMath: (node) => `$${latexOf(node.attrs)}$`,
  },
  tokens: {
    [MATH_BLOCK_TOKEN]: (token, context) => {
      context.addNode('blockMath', { latex: token.content });
      return true;
    },
    [MATH_INLINE_TOKEN]: (token, context) => {
      context.addNode('inlineMath', { latex: token.content });
      return true;
    },
  },
};

/**
 * Search projection: the LaTeX source is what a reader would search for
 * ("sum", "alpha"), so it is indexed as-is rather than dropped.
 */
export const mathematicsPlainTextAdapter: PlainTextAdapter = {
  blocks: {
    blockMath: (node) => `${latexOf(node.attrs)}\n`,
    inlineMath: (node) => latexOf(node.attrs),
  },
};

export const mathematicsBlocks: readonly BlockCatalogEntry[] = [
  {
    id: 'block-math',
    label: 'Formel',
    description: 'LaTeX-Formel als eigener Block',
    keywords: ['formel', 'mathe', 'math', 'latex', 'katex', 'gleichung', '$$'],
    group: 'advanced',
    icon: 'Sigma',
    prompt: 'latex',
    turnInto: false,
    run: (editor, value) => {
      if (value === undefined || value.length === 0) return false;
      return editor.chain().focus().insertBlockMath({ latex: value }).run();
    },
    isActive: (editor) => editor.isActive('blockMath'),
  },
];
