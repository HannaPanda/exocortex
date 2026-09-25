'use client';

import { type Node as PmNode } from '@tiptap/pm/model';
import { type Editor } from '@tiptap/react';
import { ChevronRightIcon, CopyIcon, LinkIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { BLOCK_ID_ATTRIBUTE, type BlockCatalogEntry } from '@exocortex/editor';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
} from '@exocortex/ui';

import { describeBlockRemoval, useBlockRemovalWarning } from './block-removal';
import { ColorItems } from './color-menu';
import { useDestructiveConfirm } from './destructive-confirm';
import { TurnIntoItems } from './turn-into-menu';

/** A block and where it starts, which is all any of these actions needs. */
export interface BlockTarget {
  node: PmNode;
  pos: number;
}

/**
 * Where a block stands *now*, which is not where it stood when it was picked.
 *
 * The identifier is the reliable handle: a position is only a guess once
 * anything above the block has changed, and between picking a block and
 * confirming its deletion there is a dialog's worth of time for that to happen.
 */
function currentRangeOf(editor: Editor, block: BlockTarget): { from: number; to: number } | null {
  const blockId: unknown = block.node.attrs[BLOCK_ID_ATTRIBUTE];
  if (typeof blockId !== 'string' || blockId.length === 0) {
    const still = editor.state.doc.nodeAt(block.pos);
    if (still === null || still.type !== block.node.type) return null;
    return { from: block.pos, to: block.pos + still.nodeSize };
  }

  let range: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (range !== null) return false;
    if (node.attrs[BLOCK_ID_ATTRIBUTE] !== blockId) return true;
    range = { from: pos, to: pos + node.nodeSize };
    return false;
  });
  return range;
}

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
 * Duplicate, copy-link and delete for one block.
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
      editor
        .chain()
        .focus()
        .deleteRange({ from: block.pos, to: block.pos + block.node.nodeSize })
        .run();
      return;
    }
    void confirmDestructive(removalWarning(removal)).then((confirmed) => {
      if (!confirmed) return;
      // The dialog was open for as long as it took to read: a collaborator may
      // have moved this block in the meantime, so it is looked up again.
      const range = currentRangeOf(editor, block);
      if (range !== null) editor.chain().focus().deleteRange(range).run();
    });
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
          <TurnIntoItems editor={editor} catalog={catalog} />
        </DropdownMenuContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="block-color">
          {t('color')}
          <ChevronRightIcon className="ml-auto size-3.5 opacity-60" />
        </DropdownMenuSubTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-44 overflow-y-auto">
          <ColorItems editor={editor} />
        </DropdownMenuContent>
      </DropdownMenuSub>

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
