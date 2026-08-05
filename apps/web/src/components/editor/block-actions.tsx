'use client';

import { type Node as PmNode } from '@tiptap/pm/model';
import { type Editor } from '@tiptap/react';
import { ChevronRightIcon, CopyIcon, LinkIcon, Trash2Icon } from 'lucide-react';
import * as React from 'react';

import { BLOCK_ID_ATTRIBUTE, type BlockCatalogEntry } from '@exocortex/editor';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
} from '@exocortex/ui';

import { ColorItems } from './color-menu';
import { TurnIntoItems } from './turn-into-menu';

/** A block and where it starts, which is all any of these actions needs. */
export interface BlockTarget {
  node: PmNode;
  pos: number;
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

  const remove = (): void => {
    const block = resolve();
    if (block === null) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: block.pos, to: block.pos + block.node.nodeSize })
      .run();
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
          Umwandeln in
          <ChevronRightIcon className="ml-auto size-3.5 opacity-60" />
        </DropdownMenuSubTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          <TurnIntoItems editor={editor} catalog={catalog} />
        </DropdownMenuContent>
      </DropdownMenuSub>

      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="block-color">
          Farbe
          <ChevronRightIcon className="ml-auto size-3.5 opacity-60" />
        </DropdownMenuSubTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-44 overflow-y-auto">
          <ColorItems editor={editor} />
        </DropdownMenuContent>
      </DropdownMenuSub>

      <DropdownMenuSeparator />
      <DropdownMenuItem data-testid="block-duplicate" onClick={duplicate}>
        <CopyIcon /> Duplizieren
      </DropdownMenuItem>
      <DropdownMenuItem data-testid="block-copy-link" onClick={() => void copyLink()}>
        <LinkIcon /> Link zum Block kopieren
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" data-testid="block-delete" onClick={remove}>
        <Trash2Icon /> Löschen
      </DropdownMenuItem>
    </>
  );
}
