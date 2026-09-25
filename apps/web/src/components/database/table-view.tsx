'use client';

import { Maximize2Icon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  DATABASE_TITLE_COLUMN_KEY,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView,
} from '@exocortex/contracts';
import {
  Button,
  cn,
  EmptyState,
  ErrorState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import {
  useCreateDatabaseRow,
  useDatabaseRows,
  useUpdateDatabaseRowValues,
  useUpdateDatabaseView,
} from '@/lib/api/database-queries';

import { AddPropertyButton } from './add-property-button';
import { PropertyCell } from './cells';
import { PropertyMenu } from './property-menu';
import { RowPeekSheet } from './row-peek-sheet';
import {
  clampColumnWidth,
  columnWidthOf,
  ROW_HEIGHT_LINE_CLAMP,
  rowHeightOf,
  visibleTableProperties,
} from './table-columns';

interface TableViewProps {
  workspaceId: string;
  documentId: string;
  view: DatabaseView;
  properties: DatabaseProperty[];
  readOnly: boolean;
}

/**
 * Minimum width of the trailing column. It carries "+ Eigenschaft" and, being
 * the only column without a fixed width, absorbs the space left over when the
 * table is narrower than the page.
 */
const TRAILING_COLUMN_WIDTH = 44;

export function TableView({ workspaceId, documentId, view, properties, readOnly }: TableViewProps) {
  const t = useTranslations('database.table');
  const tRows = useTranslations('database.rows');
  const rowsQuery = useDatabaseRows(documentId, { viewId: view.id, limit: 100 });
  const createRow = useCreateDatabaseRow(documentId);
  const updateValues = useUpdateDatabaseRowValues(documentId);
  const updateView = useUpdateDatabaseView(documentId);

  const [peekRowId, setPeekRowId] = React.useState<string | null>(null);
  /**
   * Width being dragged right now. Kept here rather than in the handle so the
   * `<col>` follows the pointer without a round-trip to the server; the commit
   * happens once, on pointer release.
   */
  const [draggedWidth, setDraggedWidth] = React.useState<{ key: string; width: number } | null>(
    null,
  );

  const rowHeight = rowHeightOf(view);
  const columns = visibleTableProperties(view, properties);

  const widthOf = (key: string): number =>
    draggedWidth !== null && draggedWidth.key === key
      ? draggedWidth.width
      : columnWidthOf(view, key);

  const commitWidth = (key: string, width: number): void => {
    setDraggedWidth(null);
    if (width === columnWidthOf(view, key)) return;
    updateView.mutate({
      viewId: view.id,
      request: { config: { columnWidths: { ...view.config.columnWidths, [key]: width } } },
    });
  };

  if (rowsQuery.isPending) return <LoadingState variant="skeleton" rows={4} label={t('loading')} />;
  if (rowsQuery.isError) {
    return <ErrorState title={t('loadFailed')} onRetry={() => void rowsQuery.refetch()} />;
  }

  const rows = rowsQuery.data.rows;
  const peekRow = rows.find((row) => row.document.id === peekRowId) ?? null;
  const totalWidth =
    widthOf(DATABASE_TITLE_COLUMN_KEY) +
    columns.reduce((sum, property) => sum + widthOf(property.id), 0) +
    TRAILING_COLUMN_WIDTH;

  const setValue = (
    row: DatabaseRow,
    propertyId: string,
    value: DatabaseRow['values'][number]['value'],
  ) => {
    updateValues.mutate({ rowId: row.document.id, request: { values: [{ propertyId, value }] } });
  };

  return (
    // This element is the scrollport: the table's own container is switched to
    // `overflow-visible` so the sticky header sticks against a box that really
    // scrolls, and the sticky title column stays put while scrolling sideways.
    <div className="min-h-0 flex-1 overflow-auto" data-testid="table-scroll">
      <Table
        containerClassName="overflow-visible"
        // `border-separate` so the sticky header and title column paint their
        // own borders: with `border-collapse` a shared border belongs to the
        // scrolled-away cell and disappears mid-scroll.
        className="w-full table-fixed border-separate border-spacing-0"
        style={{ minWidth: totalWidth }}
      >
        <colgroup>
          <col style={{ width: widthOf(DATABASE_TITLE_COLUMN_KEY) }} />
          {columns.map((property) => (
            <col key={property.id} style={{ width: widthOf(property.id) }} />
          ))}
          <col />
        </colgroup>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead
              className={cn(
                'group/head relative sticky top-0 left-0 z-30 border-b border-border bg-background',
                'after:absolute after:inset-y-0 after:-right-px after:w-px after:bg-border',
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate">{t('nameColumn')}</span>
                {readOnly ? null : (
                  <ColumnResizeHandle
                    width={widthOf(DATABASE_TITLE_COLUMN_KEY)}
                    label={t('resizeColumn', { name: t('nameColumn') })}
                    onDrag={(width) => setDraggedWidth({ key: DATABASE_TITLE_COLUMN_KEY, width })}
                    onCommit={(width) => commitWidth(DATABASE_TITLE_COLUMN_KEY, width)}
                  />
                )}
              </div>
            </TableHead>
            {columns.map((property) => (
              <TableHead
                key={property.id}
                className="group/head relative sticky top-0 z-20 border-b border-border bg-background"
              >
                <div className="flex items-center justify-between gap-1">
                  <PropertyMenu
                    documentId={documentId}
                    workspaceId={workspaceId}
                    property={property}
                    view={view}
                    columns={columns}
                    readOnly={readOnly}
                  />
                  {readOnly ? null : (
                    <ColumnResizeHandle
                      width={widthOf(property.id)}
                      label={t('resizeColumn', { name: property.name })}
                      onDrag={(width) => setDraggedWidth({ key: property.id, width })}
                      onCommit={(width) => commitWidth(property.id, width)}
                    />
                  )}
                </div>
              </TableHead>
            ))}
            <TableHead className="sticky top-0 z-20 border-b border-border bg-background">
              {readOnly ? null : (
                <AddPropertyButton documentId={documentId} workspaceId={workspaceId} />
              )}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.document.id}
              className="group"
              data-testid={`database-row-${row.document.id}`}
            >
              <TableCell
                className={cn(
                  'relative sticky left-0 z-10 border-b border-border bg-background p-0 align-top',
                  // The sticky cell paints over the row, so it has to repeat
                  // the row's hover colour instead of letting it show through.
                  'group-hover:bg-muted/50',
                  'after:absolute after:inset-y-0 after:-right-px after:w-px after:bg-border',
                )}
              >
                <div className="flex min-h-8 items-start gap-1 px-1.5 py-1.5">
                  <Link
                    href={`/arbeitsbereich/${workspaceId}/seite/${row.document.id}`}
                    title={row.document.title}
                    // `whitespace-normal` undoes the `nowrap` the TableCell
                    // primitive sets: white-space inherits, so without it a
                    // wrapped row height would still render one line.
                    className={cn(
                      'min-w-0 flex-1 break-words whitespace-normal hover:underline',
                      ROW_HEIGHT_LINE_CLAMP[rowHeight],
                    )}
                  >
                    {row.document.title}
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('openRow')}
                    data-testid="open-row-peek"
                    className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
                    onClick={() => setPeekRowId(row.document.id)}
                  >
                    <Maximize2Icon />
                  </Button>
                </div>
              </TableCell>
              {columns.map((property) => {
                const cellValue =
                  row.values.find((entry) => entry.propertyId === property.id)?.value ?? null;
                return (
                  <TableCell key={property.id} className="border-b border-border p-0 align-top">
                    <PropertyCell
                      property={property}
                      value={cellValue}
                      readOnly={readOnly}
                      rowHeight={rowHeight}
                      onChange={(next) => setValue(row, property.id, next)}
                    />
                  </TableCell>
                );
              })}
              <TableCell className="border-b border-border" />
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {readOnly ? null : (
        <Button
          variant="ghost"
          size="sm"
          className="ml-1 mt-1 text-muted-foreground"
          data-testid="add-row"
          onClick={() => createRow.mutate({ title: tRows('untitled'), values: [] })}
        >
          <PlusIcon /> {t('newRow')}
        </Button>
      )}

      {rows.length === 0 ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : null}

      <RowPeekSheet
        workspaceId={workspaceId}
        row={peekRow}
        properties={properties}
        readOnly={readOnly}
        onOpenChange={(open) => {
          if (!open) setPeekRowId(null);
        }}
        onChange={(propertyId, value) => {
          if (peekRow !== null) setValue(peekRow, propertyId, value);
        }}
      />
    </div>
  );
}

interface ColumnResizeHandleProps {
  width: number;
  /** The whole accessible name, naming the column and what dragging does. */
  label: string;
  onDrag: (width: number) => void;
  onCommit: (width: number) => void;
}

/**
 * Drag handle on the right edge of a header cell.
 *
 * Uses pointer capture so the drag survives the pointer leaving the 6px
 * handle, and keeps the arrow keys working for anyone who cannot drag: the
 * handle is a real button, not a bare `div`.
 */
function ColumnResizeHandle({ width, label, onDrag, onCommit }: ColumnResizeHandleProps) {
  const dragRef = React.useRef<{ startX: number; startWidth: number } | null>(null);

  return (
    <button
      type="button"
      aria-label={label}
      data-testid="column-resize"
      className={cn(
        'absolute inset-y-0 -right-px z-10 w-1.5 cursor-col-resize touch-none rounded-full',
        'opacity-0 transition-opacity hover:bg-primary focus-visible:opacity-100 group-hover/head:opacity-100',
        'hover:opacity-100 pointer-coarse:w-3 pointer-coarse:bg-border pointer-coarse:opacity-100',
      )}
      onPointerDown={(event) => {
        event.preventDefault();
        dragRef.current = { startX: event.clientX, startWidth: width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        onDrag(clampColumnWidth(drag.startWidth + (event.clientX - drag.startX)));
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        if (drag === null) return;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onCommit(clampColumnWidth(drag.startWidth + (event.clientX - drag.startX)));
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 8;
        if (event.key === 'ArrowLeft') onCommit(clampColumnWidth(width - step));
        if (event.key === 'ArrowRight') onCommit(clampColumnWidth(width + step));
      }}
    />
  );
}
