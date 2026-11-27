'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabaseProperty, type DatabaseRow } from '@exocortex/contracts';

import { useDestructiveConfirmDialog } from '@/components/editor/destructive-confirm';
import { useRowSelectionCommands } from '@/components/palette/row-selection-commands';
import {
  useDuplicateDatabaseRows,
  useTrashDatabaseRows,
  useUpdateDatabaseRows,
} from '@/lib/api/database-queries';
import { documentHref } from '@/lib/document-href';

import { type CellValue } from './cells';
import { type RowHandleActions } from './row-handle';
import { RowMoveDialog } from './row-move-dialog';
import { ROW_PEEK_ATTRIBUTE } from './row-peek';
import {
  clickRow,
  EMPTY_ROW_SELECTION,
  type RowSelection,
  selectedInOrder,
  toggleAllRows,
} from './row-selection';
import { bulkWritableProperties, RowSelectionBar } from './row-selection-bar';

/**
 * Whether an Escape belongs to something other than the selection: a field
 * being typed in, a menu or dialog, or the side panel, which closes on it first. The popup is
 * still in the document while its own handler runs, so its presence is the
 * answer.
 */
function escapeIsTaken(target: EventTarget | null): boolean {
  if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') !== null) {
    return true;
  }
  // An open side panel closes first; the selection waits for the next Escape
  // (issue #239), so closing the row never costs the rows that were chosen.
  if (document.querySelector(`[${ROW_PEEK_ATTRIBUTE}]`) !== null) return true;
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/**
 * Everything a table does with its rows besides showing and editing cells
 * (issue #244): the selection, the handle menu of each row, the bar acting on
 * the selection, their dialogs and their palette commands.
 *
 * Kept out of `TableView` so the table stays a table; it asks this hook what
 * a row's controls look like and where the bar and the dialogs go.
 */
export function useRowActions({
  workspaceId,
  documentId,
  viewId,
  rows,
  properties,
  readOnly,
  paletteEnabled,
  onOpenPeek,
}: {
  workspaceId: string;
  documentId: string;
  viewId: string;
  rows: readonly DatabaseRow[];
  properties: readonly DatabaseProperty[];
  readOnly: boolean;
  paletteEnabled: boolean;
  onOpenPeek: (rowId: string) => void;
}) {
  const t = useTranslations('database.selection');
  const router = useRouter();
  const updateRows = useUpdateDatabaseRows(documentId);
  const duplicateRows = useDuplicateDatabaseRows(documentId);
  const trashRows = useTrashDatabaseRows(documentId);
  const confirmDialog = useDestructiveConfirmDialog();

  const [selection, setSelection] = React.useState<RowSelection>(EMPTY_ROW_SELECTION);
  const [editing, setEditing] = React.useState<DatabaseProperty | null>(null);
  const [moving, setMoving] = React.useState<{ id: string; title: string } | null>(null);

  // Another view is another list: what was selected in it means nothing here.
  const [selectionView, setSelectionView] = React.useState(viewId);
  if (selectionView !== viewId) {
    setSelectionView(viewId);
    setSelection(EMPTY_ROW_SELECTION);
  }

  const order = React.useMemo(() => rows.map((row) => row.document.id), [rows]);
  const selectedIds = React.useMemo(() => selectedInOrder(selection, order), [order, selection]);
  const selectedRows = React.useMemo(
    () => rows.filter((row) => selection.ids.has(row.document.id)),
    [rows, selection],
  );
  const writable = React.useMemo(() => bulkWritableProperties(properties), [properties]);
  const busy = updateRows.isPending || duplicateRows.isPending || trashRows.isPending;
  const clear = React.useCallback(() => setSelection(EMPTY_ROW_SELECTION), []);

  // Escape lets go of the selection, unless it was meant for something else.
  React.useEffect(() => {
    if (selectedIds.length === 0) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || escapeIsTaken(event.target)) return;
      clear();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clear, selectedIds.length]);

  const trash = React.useCallback(
    async (ids: string[]): Promise<void> => {
      if (ids.length === 0) return;
      if (ids.length > 1) {
        const confirmed = await confirmDialog.confirm({
          title: t('trashConfirmTitle', { count: ids.length }),
          description: t('trashConfirmDescription', { count: ids.length }),
          confirmLabel: t('trash'),
        });
        if (!confirmed) return;
      }
      await trashRows.mutateAsync(ids);
      setSelection((current) => ({
        ids: new Set([...current.ids].filter((id) => !ids.includes(id))),
        anchor: current.anchor !== null && ids.includes(current.anchor) ? null : current.anchor,
      }));
    },
    [confirmDialog, t, trashRows],
  );

  const duplicate = React.useCallback(
    (ids: string[]): void => {
      if (ids.length > 0) duplicateRows.mutate(ids);
    },
    [duplicateRows],
  );

  const setValue = React.useCallback(
    (propertyId: string, value: CellValue): void => {
      if (selectedIds.length === 0) return;
      updateRows.mutate({ rowIds: selectedIds, values: [{ propertyId, value }] });
    },
    [selectedIds, updateRows],
  );

  const actionsFor = (row: DatabaseRow): RowHandleActions => {
    const href = documentHref(workspaceId, row.document.id, row.document.type);
    return {
      openPeek: () => onOpenPeek(row.document.id),
      openPage: () => router.push(href),
      copyLink: () => void window.navigator.clipboard.writeText(`${window.location.origin}${href}`),
      duplicate: () => duplicate([row.document.id]),
      move: () => setMoving({ id: row.document.id, title: row.document.title }),
      trash: () => void trash([row.document.id]),
    };
  };

  useRowSelectionCommands({
    enabled: paletteEnabled && !readOnly && rows.length > 0,
    selectedCount: selectedIds.length,
    properties: writable,
    handlers: {
      selectAll: () => setSelection(toggleAllRows(EMPTY_ROW_SELECTION, order)),
      clear,
      duplicate: () => duplicate(selectedIds),
      trash: () => void trash(selectedIds),
      edit: setEditing,
    },
  });

  return {
    /** Whether the checkboxes show on every row, not only on the hovered one. */
    selecting: selectedIds.length > 0,
    isSelected: (rowId: string) => selection.ids.has(rowId),
    allSelected: order.length > 0 && selectedIds.length === order.length,
    toggleRow: (rowId: string, range: boolean) =>
      setSelection((current) => clickRow(current, order, rowId, range)),
    toggleAll: () => setSelection((current) => toggleAllRows(current, order)),
    actionsFor,
    bar:
      readOnly || selectedIds.length === 0 ? null : (
        <RowSelectionBar
          rows={selectedRows}
          properties={properties}
          busy={busy}
          editing={editing}
          onEdit={setEditing}
          onSetValue={setValue}
          onDuplicate={() => duplicate(selectedIds)}
          onTrash={() => void trash(selectedIds)}
          onClear={clear}
        />
      ),
    dialogs: (
      <>
        {confirmDialog.element}
        <RowMoveDialog
          workspaceId={workspaceId}
          databaseId={documentId}
          row={moving}
          onClose={() => setMoving(null)}
        />
      </>
    ),
  };
}
