'use client';

import { Maximize2Icon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  DATABASE_TITLE_COLUMN_KEY,
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseView,
  isEmptyCellValue,
} from '@exocortex/contracts';
import {
  Button,
  Checkbox,
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
  useUpdateDatabaseViewSorts,
} from '@/lib/api/database-queries';
import { useDocumentHrefs } from '@/lib/document-href-context';

import { AddPropertyButton } from './add-property-button';
import { AiCellMark, useAiFillControls } from './ai-fill';
import { AiFillProgress } from './ai-fill-progress';
import { PropertyCell } from './cells';
import { type ColumnSortControls, TitleColumnHeader } from './column-sort';
import { PropertyMenu } from './property-menu';
import { RowHandle, type RowHandleActions } from './row-handle';
import { PEEK_TRIGGER_ATTRIBUTE, useRowPeek } from './row-peek';
import {
  clampColumnWidth,
  columnWidthOf,
  ROW_HEIGHT_LINE_CLAMP,
  rowHeightOf,
  visibleTableProperties,
} from './table-columns';
import { useRowActions } from './use-row-actions';

interface TableViewProps {
  workspaceId: string;
  documentId: string;
  view: DatabaseView;
  properties: DatabaseProperty[];
  readOnly: boolean;
  /**
   * Whether this table is the page, so its selection is offered in the
   * palette. An embedded table is a block in somebody's text (issue #148).
   */
  paletteEnabled?: boolean;
}

const NO_ROWS: readonly DatabaseRow[] = [];

/**
 * Minimum width of the trailing column. It carries "+ Eigenschaft" and, being
 * the only column without a fixed width, absorbs the space left over when the
 * table is narrower than the page.
 */
const TRAILING_COLUMN_WIDTH = 44;

/**
 * The grid line every cell draws on its right and bottom edge (issue #305).
 *
 * Real borders, never a 1px background box: a browser rounds a border's width
 * to whole device pixels, a background only its edges, so at 150 % zoom a
 * line drawn as a box came out twice as thick as the borders beside it. The
 * trailing column carries no right border, because nothing follows it.
 */
const CELL_LINES = 'border-r border-b border-border';

/**
 * The row tint (`TableRow`: `muted/50` on hover, or while one of its cells has
 * a menu open) for the pinned title cell, made opaque. The pinned cell covers
 * the columns scrolling underneath it, so a translucent tint let their text
 * show through it, and it doubled the row's own tint where both overlapped.
 * Mixed in sRGB with the page colour, it is the colour the rest of the row
 * shows, pixel for pixel.
 */
const PINNED_ROW_TINT = cn(
  'group-hover:bg-[color-mix(in_srgb,var(--color-muted)_50%,var(--color-background))]',
  'group-has-aria-expanded:bg-[color-mix(in_srgb,var(--color-muted)_50%,var(--color-background))]',
  // A selected row is tinted all the way (issue #244); muted is opaque, so the
  // pinned cell shows exactly what the row behind it shows.
  'group-data-[state=selected]:bg-muted',
);

/**
 * A row's checkbox and handle wait for the pointer (issue #244): hidden
 * until the row is hovered or one of them has focus, shown on every row while
 * any row is selected, and always on a touch screen, where nothing hovers.
 */
const ROW_CONTROL_REVEAL =
  'opacity-0 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100';

export function TableView({
  workspaceId,
  documentId,
  view,
  properties,
  readOnly,
  paletteEnabled = false,
}: TableViewProps) {
  const t = useTranslations('database.table');
  const tRows = useTranslations('database.rows');
  const rowsQuery = useDatabaseRows(documentId, { viewId: view.id, limit: 100 });
  const createRow = useCreateDatabaseRow(documentId);
  const updateValues = useUpdateDatabaseRowValues(documentId);
  const updateView = useUpdateDatabaseView(documentId);

  const router = useRouter();
  const hrefs = useDocumentHrefs();
  // A row opens beside the table, as its page (issue #239); outside a
  // document view there is no panel, and it opens as the whole page instead.
  const peek = useRowPeek();
  const openRow = React.useCallback(
    (rowId: string, options?: { selectTitle?: boolean }): void => {
      if (peek !== null) peek.open(rowId, options);
      else router.push(hrefs.href(workspaceId, rowId));
    },
    [hrefs, peek, router, workspaceId],
  );
  /**
   * Width being dragged right now. Kept here rather than in the handle so the
   * `<col>` follows the pointer without a round-trip to the server; the commit
   * happens once, on pointer release.
   */
  const [draggedWidth, setDraggedWidth] = React.useState<{ key: string; width: number } | null>(
    null,
  );

  const ai = useAiFillControls(documentId);
  const updateSorts = useUpdateDatabaseViewSorts(documentId, view.id);
  const sort: ColumnSortControls = { sorts: view.sorts, onChange: updateSorts };
  const rowActions = useRowActions({
    workspaceId,
    documentId,
    viewId: view.id,
    rows: rowsQuery.data?.rows ?? NO_ROWS,
    properties,
    readOnly,
    paletteEnabled,
    onOpenPeek: openRow,
    ai: readOnly ? undefined : ai,
  });

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
    <>
      {rowActions.bar}
      <AiFillProgress
        documentId={documentId}
        enabled={properties.some((property) => property.ai !== null && property.ai !== undefined)}
      />
      {/* This element is the scrollport: the table's own container is switched
          to `overflow-visible` so the sticky header sticks against a box that
          really scrolls, and the sticky title column stays put while scrolling
          sideways. */}
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
                className={cn('group/head sticky top-0 left-0 z-30 bg-background', CELL_LINES)}
              >
                <div className="flex items-center justify-between gap-1">
                  {readOnly ? null : (
                    <Checkbox
                      checked={rowActions.allSelected}
                      aria-label={t('selectAll')}
                      data-testid="select-all-rows"
                      className={cn(
                        'shrink-0',
                        rowActions.selecting ? null : ROW_CONTROL_REVEAL,
                        'group-hover/head:opacity-100',
                      )}
                      onCheckedChange={() => rowActions.toggleAll()}
                    />
                  )}
                  <TitleColumnHeader
                    label={t('nameColumn')}
                    columnKey={DATABASE_TITLE_COLUMN_KEY}
                    controls={sort}
                    readOnly={readOnly}
                  />
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
                  className={cn('group/head sticky top-0 z-20 bg-background', CELL_LINES)}
                >
                  <div className="flex items-center justify-between gap-1">
                    <PropertyMenu
                      documentId={documentId}
                      workspaceId={workspaceId}
                      property={property}
                      view={view}
                      columns={columns}
                      readOnly={readOnly}
                      ai={ai}
                      sort={sort}
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
                data-state={rowActions.isSelected(row.document.id) ? 'selected' : undefined}
              >
                <TableCell
                  className={cn(
                    'sticky left-0 z-10 bg-background p-0 align-top',
                    CELL_LINES,
                    PINNED_ROW_TINT,
                  )}
                >
                  <div className="flex min-h-8 items-start gap-1 px-1.5 py-1.5">
                    <RowControls
                      title={row.document.title}
                      readOnly={readOnly}
                      selecting={rowActions.selecting}
                      selected={rowActions.isSelected(row.document.id)}
                      onToggle={(range) => rowActions.toggleRow(row.document.id, range)}
                      actions={rowActions.actionsFor(row)}
                    />
                    <Link
                      href={hrefs.href(workspaceId, row.document.id, row.document.type)}
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
                      title={t('openRow')}
                      data-testid="open-row-peek"
                      aria-pressed={peek?.peekId === row.document.id}
                      {...{ [PEEK_TRIGGER_ATTRIBUTE]: row.document.id }}
                      className={cn(
                        'shrink-0',
                        peek?.peekId === row.document.id ? null : ROW_CONTROL_REVEAL,
                      )}
                      onClick={() => openRow(row.document.id)}
                    >
                      <Maximize2Icon />
                    </Button>
                  </div>
                </TableCell>
                {columns.map((property) => {
                  const cellValue =
                    row.values.find((entry) => entry.propertyId === property.id)?.value ?? null;
                  return (
                    <TableCell
                      key={property.id}
                      className={cn('group/cell relative p-0 align-top', CELL_LINES)}
                    >
                      <AiCellMark
                        row={row}
                        property={property}
                        empty={isEmptyCellValue(cellValue)}
                        readOnly={readOnly}
                        onFill={() => ai.fillCells(property, [row.document.id])}
                      />
                      <PropertyCell
                        property={property}
                        value={cellValue}
                        readOnly={readOnly}
                        rowHeight={rowHeight}
                        row={row}
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
            // A new row opens beside the table with its name selected, so it
            // is named and written in one go (issue #239).
            onClick={() =>
              void createRow
                .mutateAsync({ title: tRows('untitled'), values: [] })
                .then((created) => openRow(created.document.id, { selectTitle: true }))
            }
          >
            <PlusIcon /> {t('newRow')}
          </Button>
        )}

        {rows.length === 0 ? (
          <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
        ) : null}

        {rowActions.dialogs}
        {ai.dialogs}
      </div>
    </>
  );
}

/**
 * The start of a row (issue #244): its checkbox and its handle. The checkbox
 * selects; Shift with a click selects the range from the last row clicked.
 * A click into any other cell still edits that cell, never selects.
 */
function RowControls({
  title,
  readOnly,
  selecting,
  selected,
  onToggle,
  actions,
}: {
  title: string;
  readOnly: boolean;
  selecting: boolean;
  selected: boolean;
  onToggle: (range: boolean) => void;
  actions: RowHandleActions;
}) {
  const t = useTranslations('database.rowActions');
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {readOnly ? null : (
        <Checkbox
          checked={selected}
          aria-label={t('select', { title })}
          data-testid="row-select"
          className={cn('mx-1 mt-1.5 pointer-coarse:size-5', selecting ? null : ROW_CONTROL_REVEAL)}
          onCheckedChange={(_checked, details) => {
            const event = details.event;
            onToggle('shiftKey' in event && event.shiftKey === true);
          }}
        />
      )}
      <RowHandle
        title={title}
        readOnly={readOnly}
        actions={actions}
        className={cn('size-7', ROW_CONTROL_REVEAL, 'aria-expanded:opacity-100')}
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
