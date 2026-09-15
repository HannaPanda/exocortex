import { type DocumentSummary, type DocumentTreeNode } from '@exocortex/contracts';

/**
 * Rendering the page hierarchy for a reader with a context window.
 *
 * Split out of `pages.ts` because it is one idea with several moving parts (a
 * budget, a fair share of it, a breadth-first walk), and none of them has
 * anything to do with what the tools around it ask the API for.
 */

export function formatDocumentSummary(document: DocumentSummary): string {
  // An overview page says so on its own line: it is the one property that
  // changes what an agent should *do* with the page (write under it, not into
  // it), and a tree is where that decision is made (ADR-028).
  const overview = document.overviewMode === 'auto' ? ', Übersichtsseite' : '';
  return `${document.title} (id: ${document.id}, type: ${document.type}${overview})`;
}

/**
 * How many pages the tree renders before it stops counting them out.
 *
 * A workspace can hold thousands, and a tool result is not a place to put all
 * of them: the reader is a model with a context window. The Second Brain holds
 * 721 pages, so this cap is reached in practice, and what gets dropped matters
 * more than how much.
 */
const MAX_TREE_LINES = 300;

/**
 * Renders the hierarchy as indented lines, one page per line, each with the id
 * a follow-up call needs.
 *
 * This used to answer with the two counts alone and leave the pages themselves
 * in `structuredContent`. That is invisible to any client that reads the text
 * content, which is most of them: ChatGPT called this tool four times in a row,
 * learned "3 Wurzelseiten" each time, and then guessed a workspace. A tool
 * result has to carry its answer in the text.
 *
 * Which pages the cap keeps is the whole design, and two obvious rules are both
 * wrong. Depth-first spends the budget inside whichever section sorts first and
 * leaves the later ones out entirely, so a reader looking for "Technik"
 * concludes it does not exist. Whole-levels-only is honest but starves: the
 * Second Brain's second level is 700 pages wide, so the answer collapses to
 * eighteen section names and nothing else.
 *
 * So every root section is always listed, and what is left of the budget is
 * shared out among them evenly, one line at a time, with anything a small
 * section does not need flowing to the larger ones. Inside a section the share
 * is spent breadth-first, nearest pages first. Nothing dropped is unreachable:
 * every omitted page still has a visible ancestor to ask about.
 */
export function renderTree(nodes: readonly DocumentTreeNode[]): RenderedTree {
  const total = countNodes(nodes);

  // Not even the root level fits. Show as much of it as there is room for
  // rather than nothing: a truncated list of sections is still a map.
  if (nodes.length >= MAX_TREE_LINES) {
    const shown = nodes.slice(0, MAX_TREE_LINES);
    return {
      lines: shown.map((node) => `- ${formatDocumentSummary(node)}`),
      // Their children were not rendered, so they are not in the structured
      // half either; the section keeps its own line and its `omitted` count.
      structured: shown.map((node) => ({ ...summarize(node), children: [] })),
      omitted: total - shown.length,
      truncated: shown
        .filter((node) => node.children.length > 0)
        .map((node) => ({ id: node.id, title: node.title, omitted: countNodes(node.children) })),
    };
  }

  const demands = nodes.map((node) => countNodes(node.children));
  const shares = shareEvenly(demands, MAX_TREE_LINES - nodes.length);
  const kept = new Set<string>();
  nodes.forEach((node, index) => {
    for (const id of nearestDescendants(node, shares[index] ?? 0)) kept.add(id);
  });

  const lines: string[] = [];
  const walk = (node: DocumentTreeNode, depth: number): TreeNodeSummary => {
    lines.push(`${'  '.repeat(depth)}- ${formatDocumentSummary(node)}`);
    return {
      ...summarize(node),
      children: node.children
        .filter((child) => kept.has(child.id))
        .map((child) => walk(child, depth + 1)),
    };
  };
  const structured = nodes.map((node) => walk(node, 0));

  return {
    lines,
    structured,
    omitted: total - lines.length,
    // Named, with their ids, because "ask via the parent page" is only an
    // instruction a caller can follow if it is told which parents those are.
    truncated: nodes
      .map((node, index) => ({
        id: node.id,
        title: node.title,
        omitted: (demands[index] ?? 0) - (shares[index] ?? 0),
      }))
      .filter((section) => section.omitted > 0),
  };
}

interface RenderedTree {
  lines: string[];
  /** The same pages the lines name, for the clients that read the structure. */
  structured: TreeNodeSummary[];
  omitted: number;
  /** Sections that lost pages to the cap, largest loss first when rendered. */
  truncated: { id: string; title: string; omitted: number }[];
}

/**
 * A page in the structured tree, carrying what the rendered line carries and
 * nothing else.
 *
 * The full `DocumentSummary` is sixteen fields, and cover positions and order
 * keys are of no use to a reader that is deciding where a page belongs: 737
 * pages of them are 400 KB, against 26 KB for the same pages as text. ChatGPT's
 * connector reads this half, and answered three capped trees in a row with
 * "Sicherheitsstatus der Anfrage konnte nicht bestimmt werden" before it gave
 * up on the write it was asked for. Whatever else that check weighs, a tool
 * result that costs fifteen times its own text is not worth sending.
 */
export interface TreeNodeSummary {
  id: string;
  title: string;
  type: DocumentSummary['type'];
  children: TreeNodeSummary[];
}

export function summarize(document: DocumentSummary): Omit<TreeNodeSummary, 'children'> {
  return { id: document.id, title: document.title, type: document.type };
}

/**
 * Hands out `budget` one unit at a time, skipping anyone already satisfied, so
 * a section that wants three lines takes three and the rest goes to the ones
 * that can use it. Equal shares with the leftovers redistributed, without the
 * rounding arguments a proportional split invites.
 */
function shareEvenly(demands: readonly number[], budget: number): number[] {
  const grants = demands.map(() => 0);
  let left = budget;
  let progress = true;
  while (left > 0 && progress) {
    progress = false;
    for (const [index, demand] of demands.entries()) {
      if (left === 0) break;
      if ((grants[index] ?? 0) >= demand) continue;
      grants[index] = (grants[index] ?? 0) + 1;
      left -= 1;
      progress = true;
    }
  }
  return grants;
}

/** The `limit` descendants closest to `node`, breadth-first, as a set of ids. */
function nearestDescendants(node: DocumentTreeNode, limit: number): string[] {
  const chosen: string[] = [];
  let level: readonly DocumentTreeNode[] = node.children;
  while (level.length > 0 && chosen.length < limit) {
    const next: DocumentTreeNode[] = [];
    for (const child of level) {
      if (chosen.length >= limit) break;
      chosen.push(child.id);
      next.push(...child.children);
    }
    level = next;
  }
  return chosen;
}

function countNodes(nodes: readonly DocumentTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}
