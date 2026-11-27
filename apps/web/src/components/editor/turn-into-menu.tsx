'use client';

import { type Editor } from '@tiptap/react';
import { ChevronDownIcon } from 'lucide-react';
import * as React from 'react';

import { type BlockCatalogEntry, groupBlockCatalog } from '@exocortex/editor';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@exocortex/ui';

import { BlockIcon } from './block-icon';
import { useBlockGroupLabel } from './block-labels';
import { type BlockTarget, turnTargetInto } from './block-target';

/**
 * The menu items of "in anderen Block umwandeln".
 *
 * Split out from the menu shell so the same list can be a standalone dropdown in
 * the selection toolbar and a submenu in the block handle, without duplicating
 * the entries. In the block handle it converts the handle's block, never the
 * one holding the caret (issue #229), and a list item leaves its list for
 * anything but another list (issue #284).
 */
export function TurnIntoItems({
  editor,
  catalog,
  target = null,
}: {
  editor: Editor;
  catalog: readonly BlockCatalogEntry[];
  /** The block to convert, or `null` for the selection (the toolbar). */
  target?: BlockTarget | null;
}) {
  const groupLabel = useBlockGroupLabel();
  const sections = React.useMemo(
    () => groupBlockCatalog(catalog.filter((entry) => entry.turnInto)),
    [catalog],
  );

  return (
    <>
      {sections.map((section) => (
        <DropdownMenuGroup key={section.group}>
          <DropdownMenuLabel>{groupLabel(section.group)}</DropdownMenuLabel>
          {section.entries.map((entry) => (
            <DropdownMenuItem
              key={entry.id}
              data-testid={`turn-into-${entry.id}`}
              onClick={() => turnTargetInto(editor, target, entry)}
            >
              <BlockIcon name={entry.icon} />
              {entry.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      ))}
    </>
  );
}

/** Standalone "turn into" dropdown, used by the selection toolbar. */
export function TurnIntoMenu({
  editor,
  catalog,
  trigger,
}: {
  editor: Editor;
  catalog: readonly BlockCatalogEntry[];
  trigger: React.ReactElement<Record<string, unknown>>;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <TurnIntoItems editor={editor} catalog={catalog} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Label of the block the cursor currently sits in, for the toolbar trigger.
 *
 * Falls back to the paragraph's label, which the catalog carries in the
 * reader's language like every other one.
 */
export function currentBlockLabel(editor: Editor, catalog: readonly BlockCatalogEntry[]): string {
  const active = catalog.find((entry) => entry.turnInto && entry.isActive?.(editor) === true);
  return (active ?? catalog.find((entry) => entry.id === 'paragraph'))?.label ?? '';
}

export function TurnIntoTriggerLabel({ label }: { label: string }) {
  return (
    <>
      <span className="max-w-28 truncate">{label}</span>
      <ChevronDownIcon className="size-3.5 opacity-60" />
    </>
  );
}
