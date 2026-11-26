'use client';

import { type ComputePositionConfig, offset, shift } from '@floating-ui/dom';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { type Node as PmNode } from '@tiptap/pm/model';
import { type Editor } from '@tiptap/react';
import { GripVerticalIcon, PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type BlockCatalogEntry } from '@exocortex/editor';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@exocortex/ui';

import { BlockActionItems, type BlockTarget } from './block-actions';

/**
 * Width of the inner lane of the interaction gutter, in pixels.
 *
 * The same number as `--gutter-collapse` in `globals.css`, where the rest of the
 * gutter is defined; it cannot be read from there, because a custom property
 * resolves to `1.25rem` and not to a pixel count.
 */
const COLLAPSE_LANE = 20;

/**
 * Where the handle sits.
 *
 * `offset` moves it out of the inner lane, which belongs to the disclosure
 * button of a collapsible heading: without it the handle covers that button and
 * takes its clicks, so a section could not be collapsed while the handle was
 * showing (issue #88). `shift` is the safety net for the case where the page
 * could not reserve the full gutter — a narrow editor column with both side
 * panels pulled wide — and keeps the handle inside its clipping ancestors
 * rather than letting `AppMain` cut it off. It is deliberately left without
 * padding: the reserved gutter already leaves the handle clear of the edge, and
 * a padding would make `shift` nudge the handle on every full-width page.
 *
 * A module constant, not an object literal in the JSX: `DragHandle` lists this
 * in the dependencies of the effect that registers its plugin, and a new
 * identity per render tears that plugin down (deviation 18).
 */
const HANDLE_POSITION: ComputePositionConfig = {
  placement: 'left-start',
  strategy: 'absolute',
  middleware: [offset(COLLAPSE_LANE), shift()],
};

/**
 * Which block the handle belongs to when blocks are nested (issue #243).
 *
 * Tiptap's default also prefers the outer block when the pointer is near the
 * *top* edge of an inner one, by `500 × depth`. A list item sits two levels
 * deep, so that deduction excluded it outright, and a single-line item is so
 * short that its upper half is all top edge: hovering the first or last item
 * of a list left the handle on the block before, and dragging it moved that
 * block instead. Only the left edge is kept, which is still how a quote or a
 * callout is grabbed as a whole rather than its first paragraph.
 *
 * A module constant for the same reason as `HANDLE_POSITION`: `DragHandle`
 * normalises it inside an effect dependency.
 */
const NESTED_TARGETS = { edgeDetection: { edges: ['left' as const] } };

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
  const t = useTranslations('editor.blockHandle');
  const [target, setTarget] = React.useState<BlockTarget | null>(null);
  /**
   * True while the actions menu is open.
   *
   * A ref, not state: it must not change the identity of `handleNodeChange`
   * (see below), and it is only ever touched from event handlers.
   */
  const menuOpen = React.useRef(false);
  /**
   * The menu's open state, held here so the handle decides when it opens.
   *
   * Base UI opens a menu on the *press* of its trigger, and on this button a
   * drag starts from that same press: the menu stood in the way of the block
   * being carried, and its backdrop took every `dragover` (issue #243). So the
   * press is refused and a pointer opens the menu on release, from `click`,
   * which the browser never sends after a drag (issue #268). The keyboard is
   * untouched: Enter and Space arrive as a `click` that no pointer pressed, and
   * Base UI opens from that itself.
   */
  const [open, setOpen] = React.useState(false);
  /** The trigger's id, which anchors the menu when this component opens it. */
  const triggerId = React.useId();
  /** True from the first movement of a drag until it ends. */
  const dragging = React.useRef(false);
  /**
   * The pointer press the next `click` belongs to, and whether the menu was
   * open when it happened; `null` when a click comes from the keyboard.
   */
  const press = React.useRef<{ menuWasOpen: boolean } | null>(null);
  const changeOpen = React.useCallback(
    (next: boolean, details?: { reason: string; event: Event; cancel: () => void }): void => {
      // A drag can begin before a late open request arrives.
      if (next && dragging.current) return;
      // The press of a pointer never opens the menu; its release does.
      if (next && details?.reason === 'trigger-press' && details.event.type === 'mousedown') {
        details.cancel();
        return;
      }
      menuOpen.current = next;
      setOpen(next);
    },
    [],
  );

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

  // Memoised like `handleNodeChange` (docs/deviations.md 17).
  const handleDragStart = React.useCallback((): void => {
    dragging.current = true;
    changeOpen(false);
  }, [changeOpen]);
  const handleDragEnd = React.useCallback((): void => {
    dragging.current = false;
  }, []);

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
      nested={NESTED_TARGETS}
      onNodeChange={handleNodeChange}
      onElementDragStart={handleDragStart}
      onElementDragEnd={handleDragEnd}
      computePositionConfig={HANDLE_POSITION}
      className="exocortex-block-handle flex items-center gap-0.5 pr-1"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t('insertBelow')}
        data-testid="block-insert"
        className="text-muted-foreground hover:text-foreground"
        onMouseDown={(event) => event.preventDefault()}
        onClick={insertBelow}
      >
        <PlusIcon />
      </Button>

      <DropdownMenu open={open} triggerId={triggerId} onOpenChange={changeOpen}>
        <DropdownMenuTrigger
          id={triggerId}
          onPointerDown={() => {
            press.current = { menuWasOpen: menuOpen.current };
          }}
          onKeyDown={() => {
            press.current = null;
          }}
          onClick={() => {
            const pressed = press.current;
            press.current = null;
            // A keyboard click is Base UI's to handle, and a press on the open
            // menu's handle closed it: its release must not open it again.
            if (pressed === null || pressed.menuWasOpen) return;
            changeOpen(true);
          }}
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('actions')}
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
