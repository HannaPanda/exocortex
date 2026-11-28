import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** One coloured stretch of a code block, in characters from the start of its text. */
export interface HighlightSpan {
  from: number;
  to: number;
  /** The `hljs-*` classes of the stretch, space separated. */
  className: string;
}

interface CodeHighlightState {
  /** The code blocks the decorations were built from, in document order. */
  blocks: readonly ProseMirrorNode[];
  decorations: DecorationSet;
}

export const codeHighlightKey = new PluginKey<CodeHighlightState>('codeHighlight');

/** Every node named `name`, in document order, with its position. */
function codeBlocksOf(
  doc: ProseMirrorNode,
  name: string,
): { node: ProseMirrorNode; pos: number }[] {
  const found: { node: ProseMirrorNode; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === name) {
      found.push({ node, pos });
      return false;
    }
    // A paragraph or a heading holds no code block; its text need not be walked.
    return !node.isTextblock;
  });
  return found;
}

function sameBlocks(
  previous: readonly ProseMirrorNode[],
  next: readonly { node: ProseMirrorNode }[],
): boolean {
  return (
    previous.length === next.length && next.every((entry, index) => entry.node === previous[index])
  );
}

/**
 * The decorations that colour code blocks (issue #317).
 *
 * Replaces the plugin of `@tiptap/extension-code-block-lowlight`, which had two
 * faults. It decided whether to recompute from the shape of a transaction (the
 * caret in a code block, a changed number of blocks, a step spanning a block),
 * and a language picked from the block's bar while the caret was elsewhere is
 * an attribute step that matched none of the three: the old colours were
 * mapped forward and stayed, under any language, until the page was reloaded.
 * And a block without a language was highlighted by guessing one
 * (`highlightAuto`), so "Ohne Hervorhebung" was not without highlighting.
 *
 * This one decides from the nodes themselves. ProseMirror nodes are immutable
 * and an unchanged one is shared between documents, so a code block whose text
 * or language changed is a different object, and a block that is still the
 * same object still has the same colours. That makes the check exact for every
 * kind of change: typing, a language picked anywhere, an undo, a write that
 * arrives from the collaboration server. It is also cheaper: a keystroke in
 * one block highlights that block, not every block on the page, because the
 * spans of an unchanged block come from a cache keyed by its node.
 *
 * `spansFor` decides what a block looks like; it returns nothing for a block
 * that should stay plain.
 */
export function codeHighlightPlugin(options: {
  name: string;
  spansFor: (node: ProseMirrorNode) => readonly HighlightSpan[];
}): Plugin<CodeHighlightState> {
  const cache = new WeakMap<ProseMirrorNode, readonly HighlightSpan[]>();

  const spansOf = (node: ProseMirrorNode): readonly HighlightSpan[] => {
    const cached = cache.get(node);
    if (cached !== undefined) return cached;
    const spans = options.spansFor(node);
    cache.set(node, spans);
    return spans;
  };

  const build = (
    doc: ProseMirrorNode,
    blocks = codeBlocksOf(doc, options.name),
  ): CodeHighlightState => {
    const decorations: Decoration[] = [];
    for (const { node, pos } of blocks) {
      const start = pos + 1;
      for (const span of spansOf(node)) {
        decorations.push(
          Decoration.inline(start + span.from, start + span.to, { class: span.className }),
        );
      }
    }
    return {
      blocks: blocks.map((entry) => entry.node),
      decorations: DecorationSet.create(doc, decorations),
    };
  };

  return new Plugin<CodeHighlightState>({
    key: codeHighlightKey,
    state: {
      init: (_, { doc }) => build(doc),
      apply: (transaction, previous) => {
        if (!transaction.docChanged) return previous;
        const blocks = codeBlocksOf(transaction.doc, options.name);
        if (sameBlocks(previous.blocks, blocks)) {
          // Only text around the blocks changed; they moved, intact.
          return {
            blocks: previous.blocks,
            decorations: previous.decorations.map(transaction.mapping, transaction.doc),
          };
        }
        return build(transaction.doc, blocks);
      },
    },
    props: {
      decorations: (state) => codeHighlightKey.getState(state)?.decorations,
    },
  });
}
