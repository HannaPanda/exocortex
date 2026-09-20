import { type Node as PmNode } from '@tiptap/pm/model';

/** What a confirmation dialog says before a block is removed. */
export interface BlockRemovalWarning {
  title: string;
  description: string;
}

/**
 * The blocks whose removal is worth a question (issue #91).
 *
 * Each of these either holds other blocks, or holds a configuration that took a
 * dialog to produce. Losing one costs more than the click that lost it, which is
 * the whole argument for the dialog: a paragraph is retyped in a second, a table
 * with three filled rows is not.
 *
 * The map is deliberately a list of node names rather than a rule over the
 * schema ("does it take block content"): a callout and a details block both do,
 * and so does a list item, which is far too small to ask about.
 */
const COMPOUND_BLOCK_NAMES: Readonly<Record<string, string>> = {
  table: 'Tabelle',
  codeBlock: 'Codeblock',
  blockquote: 'Zitat',
  bulletList: 'Liste',
  orderedList: 'Nummerierte Liste',
  taskList: 'Aufgabenliste',
  details: 'Umschaltblock',
  callout: 'Hinweis',
  columnList: 'Spaltenlayout',
  databaseEmbed: 'Eingebettete Datenbank',
  savedQueryEmbed: 'Abfrageblock',
};

/** Names for the blocks that are only asked about once they carry enough text. */
const TEXT_BLOCK_NAMES: Readonly<Record<string, string>> = {
  paragraph: 'Absatz',
  heading: 'Überschrift',
};

/**
 * How much text turns a plain block into something worth asking about.
 *
 * Roughly a short paragraph. Below it, undo is the cheaper protection and a
 * dialog is in the way; above it, the click destroyed something that was
 * written rather than typed.
 */
const SUBSTANTIAL_TEXT_LENGTH = 280;

/** How the table is described, so the dialog says what is actually lost. */
function describeTable(node: PmNode): string {
  const rows = node.childCount;
  const columns = rows === 0 ? 0 : node.child(0).childCount;
  return `Die Tabelle mit ${rows} Zeilen und ${columns} Spalten wird mit ihrem gesamten Inhalt entfernt.`;
}

/**
 * The question to ask before this block is deleted, or `null` when it should
 * simply go.
 *
 * Small, cheap edits stay unprotected on purpose: a confirmation on every
 * deletion trains the hand to click it away, and then it protects nothing.
 */
export function describeBlockRemoval(node: PmNode): BlockRemovalWarning | null {
  const undoHint = 'Mit Strg+Z lässt sich das Löschen rückgängig machen.';

  const compound = COMPOUND_BLOCK_NAMES[node.type.name];
  if (compound !== undefined) {
    const what =
      node.type.name === 'table'
        ? describeTable(node)
        : 'Der Block wird mit seinem gesamten Inhalt entfernt.';
    return { title: `${compound} löschen?`, description: `${what} ${undoHint}` };
  }

  if (node.textContent.length < SUBSTANTIAL_TEXT_LENGTH) return null;
  const name = TEXT_BLOCK_NAMES[node.type.name] ?? 'Block';
  return {
    title: `${name} löschen?`,
    description: `${node.textContent.length} Zeichen werden entfernt. ${undoHint}`,
  };
}
