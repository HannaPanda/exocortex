'use client';

import { type Editor } from '@tiptap/react';
import {
  ArrowDown01Icon,
  ArrowDownAZIcon,
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  CopyIcon,
  LinkIcon,
  ListChecksIcon,
  Trash2Icon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  BLOCK_ID_ATTRIBUTE,
  type BlockCatalogEntry,
  type ListSortOrder,
  listSortOrders,
  movableBlockAt,
  moveBlockTransaction,
  sortableListAt,
  sortableListAtSelection,
  sortListTransaction,
} from '@exocortex/editor';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
} from '@exocortex/ui';

import { describeBlockRemoval, useBlockRemovalWarning } from './block-removal';
import { type BlockTarget, currentRangeOf, deleteBlockRange } from './block-target';
import { ColorItems } from './color-menu';
import { useDestructiveConfirm } from './destructive-confirm';
import { TurnIntoItems } from './turn-into-menu';

const SORT_ICONS: Record<ListSortOrder, typeof ArrowDownAZIcon> = {
  checked: ListChecksIcon,
  alphabetical: ArrowDownAZIcon,
  numeric: ArrowDown01Icon,
};

const SORT_LABELS = {
  checked: 'sortChecked',
  alphabetical: 'sortAlphabetical',
  numeric: 'sortNumeric',
} as const satisfies Record<ListSortOrder, string>;

/**
 * The top-level block the cursor is in.
 *
 * Used when the actions are opened from the selection toolbar, where there is no
 * hovered node to work from.
 */
export function blockTargetFromSelection(editor: Editor): BlockTarget | null {
  const { $from } = editor.state.selection;
  if ($from.depth === 0) return null;
  return { node: $from.node(1), pos: $from.before(1) };
}

/**
 * Turn into, colour, move, sort (a list), duplicate, copy-link and delete for
 * one block.
 *
 * Every one of them acts on `target` when the handle opened the menu, never on
 * the block holding the caret (issue #229).
 *
 * Shared by the drag handle in the gutter and by the selection toolbar, so both
 * offer exactly the same actions with one implementation.
 */
export function BlockActionItems({
  editor,
  catalog,
  target,
}: {
  editor: Editor;
  catalog: readonly BlockCatalogEntry[];
  /** The block to act on, or `null` to use the one the cursor is in. */
  target: BlockTarget | null;
}) {
  const t = useTranslations('editor.blockActions');
  const locale = useLocale();
  const confirmDestructive = useDestructiveConfirm();
  const removalWarning = useBlockRemovalWarning();
  const resolve = (): BlockTarget | null => target ?? blockTargetFromSelection(editor);

  const duplicate = (): void => {
    const block = resolve();
    if (block === null) return;
    editor
      .chain()
      .focus()
      .insertContentAt(block.pos + block.node.nodeSize, block.node.toJSON())
      .run();
  };

  /**
   * Deletion, with a question in front of the blocks that are worth one.
   *
   * `describeBlockRemoval` decides which those are; a short paragraph is deleted
   * straight away, because a dialog on every block is a dialog nobody reads
   * (issue #91).
   */
  const remove = (): void => {
    const block = resolve();
    if (block === null) return;
    const removal = describeBlockRemoval(block.node);
    if (removal === null) {
      deleteBlockRange(editor, { from: block.pos, to: block.pos + block.node.nodeSize });
      return;
    }
    void confirmDestructive(removalWarning(removal)).then((confirmed) => {
      if (!confirmed) return;
      // The dialog was open for as long as it took to read: a collaborator may
      // have moved this block in the meantime, so it is looked up again.
      const range = currentRangeOf(editor, block);
      if (range !== null) deleteBlockRange(editor, range);
    });
  };

  /**
   * One place up or down among its neighbours (issue #243), the menu twin of
   * `Strg+Umschalt+Pfeil`. Opened from the selection toolbar it moves the block
   * the keyboard would move, a list item rather than its whole list.
   */
  const move = (direction: 1 | -1): void => {
    const block = target ?? movableBlockAt(editor.state);
    if (block === null) return;
    const tr = moveBlockTransaction(editor.state, block.pos, direction);
    if (tr !== null) editor.view.dispatch(tr);
    editor.commands.focus();
  };

  /**
   * The list "Sortieren" puts in order (issue #253): the one the handle's item
   * stands in, or the handle's list itself; from the selection toolbar the
   * innermost list around the caret. Read while the menu renders, which is
   * when it opens, so the entry is only there for a list it can sort.
   */
  const targetRange = target === null ? null : currentRangeOf(editor, target);
  const sortable =
    target === null
      ? sortableListAtSelection(editor.state)
      : targetRange === null
        ? null
        : sortableListAt(editor.state.doc, targetRange.from);
  const sortOrders = sortable === null ? [] : listSortOrders(sortable.node);

  /**
   * One sort, as one ordinary step: no mode is stored, nothing re-sorts later,
   * and `Strg+Z` takes it back. The list is found again by its id first.
   */
  const sortList = (order: ListSortOrder): void => {
    if (sortable === null) return;
    const range = currentRangeOf(editor, sortable);
    if (range === null) return;
    const tr = sortListTransaction(editor.state, range.from, order, locale);
    if (tr !== null) editor.view.dispatch(tr.scrollIntoView());
    editor.commands.focus();
  };

  /** Deep link built from the stable block id, never from a document offset. */
  const copyLink = async (): Promise<void> => {
    const blockId = resolve()?.node.attrs[BLOCK_ID_ATTRIBUTE];
    if (typeof blockId !== 'string' || blockId.length === 0) return;
    await window.navigator.clipboard.writeText(
      `${window.location.origin}${window.location.pathname}#${blockId}`,
    );
  };

  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="block-turn-into">
          {t('turnInto')}
          <ChevronRightIcon className="ml-auto size-3.5 opacity-60" />
        </DropdownMenuSubTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          <TurnIntoItems editor={editor} catalog={catalog} target={target} />
        </DropdownMenuContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="block-color">
          {t('color')}
          <ChevronRightIcon className="ml-auto size-3.5 opacity-60" />
        </DropdownMenuSubTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-44 overflow-y-auto">
          <ColorItems editor={editor} target={target} />
        </DropdownMenuContent>
      </DropdownMenuSub>

      <DropdownMenuSeparator />
      <DropdownMenuItem data-testid="block-move-up" onClick={() => move(-1)}>
        <ArrowUpIcon /> {t('moveUp')}
        <DropdownMenuShortcut>{t('moveUpShortcut')}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem data-testid="block-move-down" onClick={() => move(1)}>
        <ArrowDownIcon /> {t('moveDown')}
        <DropdownMenuShortcut>{t('moveDownShortcut')}</DropdownMenuShortcut>
      </DropdownMenuItem>
      {sortOrders.length > 0 ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="block-sort">
            <ArrowUpDownIcon /> {t('sort')}
            <ChevronRightIcon className="ml-auto size-3.5 opacity-60" />
          </DropdownMenuSubTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {sortOrders.map((order) => {
              const Icon = SORT_ICONS[order];
              return (
                <DropdownMenuItem
                  key={order}
                  data-testid={`block-sort-${order}`}
                  onClick={() => sortList(order)}
                >
                  <Icon /> {t(SORT_LABELS[order])}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenuSub>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem data-testid="block-duplicate" onClick={duplicate}>
        <CopyIcon /> {t('duplicate')}
      </DropdownMenuItem>
      <DropdownMenuItem data-testid="block-copy-link" onClick={() => void copyLink()}>
        <LinkIcon /> {t('copyLink')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" data-testid="block-delete" onClick={remove}>
        <Trash2Icon /> {t('delete')}
      </DropdownMenuItem>
    </>
  );
}
