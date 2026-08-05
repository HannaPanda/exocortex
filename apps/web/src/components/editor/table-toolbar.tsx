'use client';

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
import * as React from 'react';

import { Button, Toolbar, ToolbarSeparator } from '@exocortex/ui';

interface TableAction {
  id: string;
  label: string;
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
    label: 'Zeile darunter einfügen',
    icon: ArrowDownToLineIcon,
    run: (editor) => editor.chain().focus().addRowAfter().run(),
  },
  {
    id: 'add-column',
    label: 'Spalte rechts einfügen',
    icon: ArrowRightToLineIcon,
    run: (editor) => editor.chain().focus().addColumnAfter().run(),
  },
  {
    id: 'toggle-header-row',
    label: 'Kopfzeile umschalten',
    icon: Heading1Icon,
    run: (editor) => editor.chain().focus().toggleHeaderRow().run(),
  },
  {
    id: 'merge-or-split',
    label: 'Zellen verbinden oder teilen',
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
    label: 'Zeile löschen',
    icon: Rows3Icon,
    run: (editor) => editor.chain().focus().deleteRow().run(),
    destructive: true,
  },
  {
    id: 'delete-column',
    label: 'Spalte löschen',
    icon: Columns3Icon,
    run: (editor) => editor.chain().focus().deleteColumn().run(),
    destructive: true,
  },
];

/** Controls for the table the cursor is in. */
export function TableToolbar({ editor }: { editor: Editor }) {
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableToolbar"
      options={{ placement: 'top', offset: 8 }}
      shouldShow={({ editor: instance }) => instance.isEditable && instance.isActive('table')}
    >
      <Toolbar aria-label="Tabelle" data-testid="table-toolbar">
        {/* Plain buttons; see the note in `selection-toolbar.tsx`. `title` because
            an icon-only control is otherwise unnamed for a pointer user: the
            accessible name alone never appears on screen. */}
        {[...TABLE_ACTIONS, ...TABLE_REMOVALS].map((action, index) => (
          <React.Fragment key={action.id}>
            {index === TABLE_ACTIONS.length ? <ToolbarSeparator /> : null}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={action.label}
              title={action.label}
              data-testid={`table-${action.id}`}
              className={action.destructive === true ? 'text-destructive-text' : undefined}
              // Keeps the cell selection; see the note in `selection-toolbar.tsx`.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => action.run(editor)}
            >
              <action.icon />
            </Button>
          </React.Fragment>
        ))}

        <Button
          variant="ghost"
          size="sm"
          data-testid="table-delete"
          className="text-destructive-text"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.chain().focus().deleteTable().run()}
        >
          <Trash2Icon /> Tabelle löschen
        </Button>
      </Toolbar>
    </BubbleMenu>
  );
}
