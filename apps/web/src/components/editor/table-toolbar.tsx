'use client';

import { type Node as PmNode } from '@tiptap/pm/model';
import { type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import {
  ArrowDownToLineIcon,
  ArrowRightToLineIcon,
  Columns3Icon,
  CombineIcon,
  Heading1Icon,
  Rows3Icon,
  Trash2Icon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { Button, Toolbar, ToolbarButton, ToolbarSeparator } from '@exocortex/ui';

import { describeBlockRemoval, useBlockRemovalWarning } from './block-removal';
import { useDestructiveConfirm } from './destructive-confirm';

interface TableAction {
  id: string;
  /** Key in `editor.table`. */
  labelKey:
    'addRow' | 'addColumn' | 'toggleHeaderRow' | 'mergeOrSplit' | 'deleteRow' | 'deleteColumn';
  icon: React.ComponentType<{ className?: string }>;
  run: (editor: Editor) => void;
  destructive?: boolean;
}

/**
 * Table actions, kept to the five that matter in a document.
 *
 * Deliberately not the full ProseMirror table API: a document table is a small
 * layout of text, and a toolbar with fourteen buttons is slower to use than one
 * with five (DESIGN.md, density over decoration). Rows and columns are added
 * *after* the cursor, which is what "add" means while writing left to right.
 */
const TABLE_ACTIONS: readonly TableAction[] = [
  {
    id: 'add-row',
    labelKey: 'addRow',
    icon: ArrowDownToLineIcon,
    run: (editor) => editor.chain().focus().addRowAfter().run(),
  },
  {
    id: 'add-column',
    labelKey: 'addColumn',
    icon: ArrowRightToLineIcon,
    run: (editor) => editor.chain().focus().addColumnAfter().run(),
  },
  {
    id: 'toggle-header-row',
    labelKey: 'toggleHeaderRow',
    icon: Heading1Icon,
    run: (editor) => editor.chain().focus().toggleHeaderRow().run(),
  },
  {
    id: 'merge-or-split',
    labelKey: 'mergeOrSplit',
    icon: CombineIcon,
    run: (editor) => editor.chain().focus().mergeOrSplit().run(),
  },
];

/**
 * Removing is as much a part of shaping a table as adding.
 *
 * Every "add" above has its counterpart here; without the column one, a table
 * could only ever grow.
 */
const TABLE_REMOVALS: readonly TableAction[] = [
  {
    id: 'delete-row',
    labelKey: 'deleteRow',
    icon: Rows3Icon,
    run: (editor) => editor.chain().focus().deleteRow().run(),
    destructive: true,
  },
  {
    id: 'delete-column',
    labelKey: 'deleteColumn',
    icon: Columns3Icon,
    run: (editor) => editor.chain().focus().deleteColumn().run(),
    destructive: true,
  },
];

/**
 * The table node the cursor stands in, so the dialog can say how much is lost.
 *
 * Walks up from the selection rather than asking the schema: the cursor is in a
 * cell, and the toolbar only ever shows while it is.
 */
function tableAtSelection(editor: Editor): PmNode | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'table') return node;
  }
  return null;
}

/** Controls for the table the cursor is in. */
export function TableToolbar({ editor }: { editor: Editor }) {
  const t = useTranslations('editor.table');
  const confirmDestructive = useDestructiveConfirm();
  const removalWarning = useBlockRemovalWarning();

  /*
   * The one action that loses a whole structure at once, and the one the issue
   * was written about (#91): the button sits a few pixels from "Spalte löschen"
   * and took the table with one click. Undo works again, but a question asked
   * before the fact is cheaper than a recovery after it.
   */
  const deleteTable = (): void => {
    const table = tableAtSelection(editor);
    const removal = table === null ? null : describeBlockRemoval(table);
    if (removal === null) {
      editor.chain().focus().deleteTable().run();
      return;
    }
    void confirmDestructive(removalWarning(removal)).then((confirmed) => {
      if (confirmed) editor.chain().focus().deleteTable().run();
    });
  };

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableToolbar"
      options={{ placement: 'top', offset: 8 }}
      shouldShow={({ editor: instance }) => instance.isEditable && instance.isActive('table')}
    >
      <Toolbar aria-label={t('label')} data-testid="table-toolbar">
        {/* `title` because an icon-only control is otherwise unnamed for a pointer
            user: the accessible name alone never appears on screen. */}
        {[...TABLE_ACTIONS, ...TABLE_REMOVALS].map((action, index) => (
          <React.Fragment key={action.id}>
            {index === TABLE_ACTIONS.length ? <ToolbarSeparator /> : null}
            <ToolbarButton
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t(action.labelKey)}
                  title={t(action.labelKey)}
                  data-testid={`table-${action.id}`}
                  className={action.destructive === true ? 'text-destructive-text' : undefined}
                  // Keeps the cell selection; see the note in `selection-toolbar.tsx`.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => action.run(editor)}
                />
              }
            >
              <action.icon />
            </ToolbarButton>
          </React.Fragment>
        ))}

        <ToolbarButton
          render={
            <Button
              variant="ghost"
              size="sm"
              data-testid="table-delete"
              className="text-destructive-text"
              onMouseDown={(event) => event.preventDefault()}
              onClick={deleteTable}
            />
          }
        >
          <Trash2Icon /> {t('deleteTable')}
        </ToolbarButton>
      </Toolbar>
    </BubbleMenu>
  );
}
