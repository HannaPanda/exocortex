import { type Node as PmNode } from '@tiptap/pm/model';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DestructiveConfirmRequest } from './destructive-confirm';

/**
 * What is about to be lost, without the words for it.
 *
 * The sentence is written by `useBlockRemovalWarning` in the reader's language;
 * this stays a pure description, so it can be tested without a translator.
 */
export type BlockRemoval =
  | { kind: 'table'; block: 'table'; rows: number; columns: number }
  | { kind: 'compound'; block: CompoundBlock }
  | { kind: 'text'; block: TextBlock | 'block'; characters: number };

/**
 * The blocks whose removal is worth a question (issue #91).
 *
 * Each of these either holds other blocks, or holds a configuration that took a
 * dialog to produce. Losing one costs more than the click that lost it, which is
 * the whole argument for the dialog: a paragraph is retyped in a second, a table
 * with three filled rows is not.
 *
 * The list is deliberately one of node names rather than a rule over the
 * schema ("does it take block content"): a callout and a details block both do,
 * and so does a list item, which is far too small to ask about.
 */
const COMPOUND_BLOCKS = [
  'table',
  'codeBlock',
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'details',
  'callout',
  'columnList',
  'databaseEmbed',
  'savedQueryEmbed',
] as const;

type CompoundBlock = (typeof COMPOUND_BLOCKS)[number];

/** The blocks that are only asked about once they carry enough text. */
const TEXT_BLOCKS = ['paragraph', 'heading'] as const;

type TextBlock = (typeof TEXT_BLOCKS)[number];

function isOneOf<T extends string>(list: readonly T[], name: string): name is T {
  return (list as readonly string[]).includes(name);
}

/**
 * How much text turns a plain block into something worth asking about.
 *
 * Roughly a short paragraph. Below it, undo is the cheaper protection and a
 * dialog is in the way; above it, the click destroyed something that was
 * written rather than typed.
 */
const SUBSTANTIAL_TEXT_LENGTH = 280;

/**
 * What is lost when this block is deleted, or `null` when it should simply go.
 *
 * Small, cheap edits stay unprotected on purpose: a confirmation on every
 * deletion trains the hand to click it away, and then it protects nothing.
 */
export function describeBlockRemoval(node: PmNode): BlockRemoval | null {
  const name = node.type.name;
  if (name === 'table') {
    const rows = node.childCount;
    const columns = rows === 0 ? 0 : node.child(0).childCount;
    return { kind: 'table', block: 'table', rows, columns };
  }
  if (isOneOf(COMPOUND_BLOCKS, name)) return { kind: 'compound', block: name };

  const characters = node.textContent.length;
  if (characters < SUBSTANTIAL_TEXT_LENGTH) return null;
  return { kind: 'text', block: isOneOf(TEXT_BLOCKS, name) ? name : 'block', characters };
}

/**
 * The question to ask before a block is deleted, in the reader's language.
 *
 * The description says what disappears (the table's size, the amount of text)
 * and then how to get it back.
 */
export function useBlockRemovalWarning(): (removal: BlockRemoval) => DestructiveConfirmRequest {
  const t = useTranslations('editor.blockRemoval');
  return React.useCallback(
    (removal: BlockRemoval): DestructiveConfirmRequest => {
      const what =
        removal.kind === 'table'
          ? t('table', { rows: removal.rows, columns: removal.columns })
          : removal.kind === 'compound'
            ? t('compound')
            : t('text', { count: removal.characters });
      return { title: t(`title.${removal.block}`), description: `${what} ${t('undoHint')}` };
    },
    [t],
  );
}
