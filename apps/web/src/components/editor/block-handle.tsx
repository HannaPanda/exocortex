'use client';

import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { type Node as PmNode } from '@tiptap/pm/model';
import { type Editor } from '@tiptap/react';
import { GripVerticalIcon, PlusIcon } from 'lucide-react';
import * as React from 'react';

import { type BlockCatalogEntry } from '@exocortex/editor';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@exocortex/ui';

import { BlockActionItems, type BlockTarget } from './block-actions';

interface BlockHandleProps {
  editor: Editor;
  catalog: readonly BlockCatalogEntry[];
}

/**
 * The block handle in the left gutter: drag to reorder, click for block actions.
 *
 * The same actions are also on the selection toolbar (`BlockActionItems`), so both
 * a pointer and a keyboard reach every one of them.
 */
export function BlockHandle({ editor, catalog }: BlockHandleProps) {
  const [target, setTarget] = React.useState<BlockTarget | null>(null);
  /**
   * True while the actions menu is open.
   *
   * A ref, not state: it must not change the identity of `handleNodeChange`
   * (see below), and it is only ever touched from event handlers.
   */
  const menuOpen = React.useRef(false);

  /**
   * Must keep a stable identity for the lifetime of the editor.
   *
   * `DragHandle` lists this callback in the dependencies of the effect that
   * registers its ProseMirror plugin, and registering sets the handle element
   * back to `visibility: hidden`. With a new function per render, every hovered
   * block tore the plugin down and rebuilt it, so the handle was only visible
   * for as long as `mousemove` events kept re-showing it: it vanished the moment
   * the pointer stopped. `unregisterPlugin` also destroys *every other* plugin
   * view, which took the suggestion menus with it.
   */
  const handleNodeChange = React.useCallback(
    ({ node, pos }: { node: PmNode | null; pos: number }): void => {
      // Freeze the target while the menu is open: the pointer has to leave the
      // block to reach the menu, and the actions must still hit that block.
      if (menuOpen.current) return;
      setTarget((current) => {
        if (node === null) return current === null ? current : null;
        if (current !== null && current.pos === pos && current.node === node) return current;
        return { node, pos };
      });
    },
    [],
  );

  const insertBelow = (): void => {
    if (target === null) return;
    editor
      .chain()
      .focus()
      .insertContentAt(target.pos + target.node.nodeSize, { type: 'paragraph' })
      .run();
  };

  return (
    <DragHandle
      editor={editor}
      nested
      onNodeChange={handleNodeChange}
      className="exocortex-block-handle flex items-center gap-0.5 pr-1"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Block darunter einfügen"
        data-testid="block-insert"
        className="text-muted-foreground hover:text-foreground"
        onMouseDown={(event) => event.preventDefault()}
        onClick={insertBelow}
      >
        <PlusIcon />
      </Button>

      <DropdownMenu
        onOpenChange={(open: boolean) => {
          menuOpen.current = open;
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Blockaktionen"
              data-testid="block-handle"
              className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
            >
              <GripVerticalIcon />
            </Button>
          }
        />
        <DropdownMenuContent align="start">
          <BlockActionItems editor={editor} catalog={catalog} target={target} />
        </DropdownMenuContent>
      </DropdownMenu>
    </DragHandle>
  );
}
