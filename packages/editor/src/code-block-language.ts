import { type Node as PmNode, type NodeType } from '@tiptap/pm/model';

/**
 * The language a new code block starts with (issue #258).
 *
 * The code blocks of one page are mostly in one language, so a new one takes
 * the language of its nearest neighbour instead of starting without one:
 *
 * - the nearest code block **before** the new one, wherever it stands (in a
 *   list, a callout, a column);
 * - with none before it, the nearest one **after** it;
 * - with no code block on the page, no language, as before.
 *
 * The rule reads the page rather than remembering the last choice somewhere:
 * there is nothing to store, nothing to keep in sync between two people
 * writing on the same page, and the answer is the same after a reload. The
 * neighbour stands for "the language last chosen here" because a page is
 * written top to bottom, and the block above is what the writer just did.
 *
 * A neighbour without a language counts as a choice: the new block then
 * starts without one too. Skipping it would let a block three screens up
 * decide over the plain output block right above, and "the block above
 * decides" is a rule a reader can predict. A name the picker does not offer
 * (`text`, `dotenv`) is taken over as it stands, like every other name.
 *
 * Only the editor's own commands ask this (the catalog entry behind the slash
 * menu and "Umwandeln in", `Mod-Alt-c`, the ``` fence without a name). A
 * Markdown fence without a language written by an agent or an import stays
 * without one: that text said what it meant.
 *
 * Returns the language, or `null` for none. `from` and `to` are the edges of
 * the selection the new block is made from; a code block between them is
 * neither before nor after it.
 */
export function neighbourCodeLanguage(
  doc: PmNode,
  from: number,
  to: number,
  type: NodeType,
): string | null {
  // An object rather than two `let`s: TypeScript does not see assignments in
  // the callback and would narrow them to `null` for good.
  const found: { before: PmNode | null; after: PmNode | null } = { before: null, after: null };
  doc.descendants((node, pos) => {
    if (found.after !== null) return false;
    if (node.type !== type) return true;
    if (pos + node.nodeSize <= from) found.before = node;
    else if (pos >= to) found.after = node;
    return false;
  });
  const neighbour = found.before ?? found.after;
  if (neighbour === null) return null;
  const language: unknown = neighbour.attrs.language;
  return typeof language === 'string' && language.length > 0 ? language : null;
}
