'use client';

import { MoreHorizontalIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { type DatabaseProperty, type DatabaseRow, type DatabaseView } from '@exocortex/contracts';
import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import {
  useCreateDatabaseRow,
  useDatabaseRows,
  useUpdateDatabaseRowValues,
  useUpdateDatabaseView,
} from '@/lib/api/database-queries';

import { PropertyValueDisplay } from './cells';
import { OPTION_COLOR_BG_CLASS, OPTION_COLOR_TEXT_CLASS } from './property-types';

interface BoardViewProps {
  workspaceId: string;
  documentId: string;
  view: DatabaseView;
  properties: DatabaseProperty[];
  readOnly: boolean;
}

const NO_VALUE_COLUMN = '__no_value__';

/**
 * Groups rows into columns by a SELECT property's value. Card reorder within
 * or across columns reuses `documents.move`/row-value updates rather than a
 * dedicated board endpoint — see ADR-011: a row is a `Document`, so it
 * already has an `orderKey` and the existing move/update-values routes cover
 * both "reorder in place" and "move to another column".
 */
export function BoardView({ workspaceId, documentId, view, properties, readOnly }: BoardViewProps) {
  const groupProperty = properties.find((property) => property.id === view.groupByPropertyId);
  const selectProperties = properties.filter((property) => property.type === 'SELECT');
  const updateView = useUpdateDatabaseView(documentId);

  if (groupProperty === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">
            Wähle eine Auswahl-Eigenschaft, nach der die Karten gruppiert werden.
          </p>
          {selectProperties.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Diese Datenbank hat noch keine Eigenschaft vom Typ „Auswahl“.
            </p>
          ) : (
            <Select
              value={null}
              onValueChange={(propertyId: string | null) => {
                if (propertyId === null) return;
                updateView.mutate({ viewId: view.id, request: { groupByPropertyId: propertyId } });
              }}
            >
              <SelectTrigger className="w-56" data-testid="board-group-by">
                <SelectValue>
                  {(value: string | null) =>
                    value === null
                      ? 'Eigenschaft wählen'
                      : selectProperties.find((p) => p.id === value)?.name
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {selectProperties.map((property) => (
                  <SelectItem key={property.id} value={property.id}>
                    {property.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    );
  }

  return (
    <BoardColumns
      workspaceId={workspaceId}
      documentId={documentId}
      view={view}
      properties={properties}
      groupProperty={groupProperty}
      readOnly={readOnly}
    />
  );
}

function BoardColumns({
  workspaceId,
  documentId,
  view,
  properties,
  groupProperty,
  readOnly,
}: {
  workspaceId: string;
  documentId: string;
  view: DatabaseView;
  properties: DatabaseProperty[];
  groupProperty: DatabaseProperty;
  readOnly: boolean;
}) {
  const rowsQuery = useDatabaseRows(documentId, { viewId: view.id, limit: 100 });
  const createRow = useCreateDatabaseRow(documentId);
  const updateValues = useUpdateDatabaseRowValues(documentId);

  if (rowsQuery.isPending)
    return <LoadingState variant="skeleton" rows={4} label="Karten werden geladen" />;
  if (rowsQuery.isError)
    return <EmptyState title="Karten nicht geladen" description="Bitte versuche es erneut." />;

  const otherProperties = properties
    .filter((property) => property.id !== groupProperty.id)
    .slice(0, 3);

  const propertyValue = (row: DatabaseRow, propertyId: string) =>
    row.values.find((entry) => entry.propertyId === propertyId)?.value ?? null;

  const columnValue = (row: DatabaseRow): string =>
    (propertyValue(row, groupProperty.id) as string | null) ?? NO_VALUE_COLUMN;

  const rowsByColumn = new Map<string, DatabaseRow[]>();
  for (const row of rowsQuery.data.rows) {
    const key = columnValue(row);
    const list = rowsByColumn.get(key);
    if (list === undefined) rowsByColumn.set(key, [row]);
    else list.push(row);
  }

  const columns = [
    ...groupProperty.options.map((option) => ({
      id: option.id,
      label: option.label,
      color: option.color,
    })),
    { id: NO_VALUE_COLUMN, label: 'Ohne Wert', color: 'gray' as const },
  ];

  const moveRow = (row: DatabaseRow, targetOptionId: string) => {
    updateValues.mutate({
      rowId: row.document.id,
      request: {
        values: [
          {
            propertyId: groupProperty.id,
            value: targetOptionId === NO_VALUE_COLUMN ? null : targetOptionId,
          },
        ],
      },
    });
  };

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
      {columns.map((column) => {
        const rows = rowsByColumn.get(column.id) ?? [];
        return (
          <div
            key={column.id}
            className="flex w-64 shrink-0 flex-col gap-2 rounded-lg bg-surface p-2"
          >
            <div className="flex items-center justify-between px-1">
              {column.id === NO_VALUE_COLUMN ? (
                <span className="text-xs font-medium text-muted-foreground">{column.label}</span>
              ) : (
                <Badge
                  variant="outline"
                  className={cn(
                    'border-transparent',
                    OPTION_COLOR_BG_CLASS[column.color],
                    OPTION_COLOR_TEXT_CLASS[column.color],
                  )}
                >
                  {column.label}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{rows.length}</span>
            </div>

            <div className="flex flex-col gap-1.5">
              {rows.map((row) => (
                <div
                  key={row.document.id}
                  className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-2"
                >
                  <div className="flex items-start justify-between gap-1">
                    <Link
                      href={`/arbeitsbereich/${workspaceId}/seite/${row.document.id}`}
                      className="min-w-0 flex-1 truncate text-sm font-medium hover:underline"
                    >
                      {row.document.title}
                    </Link>
                    {readOnly ? null : (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button variant="ghost" size="icon-sm" aria-label="Karte verschieben">
                              <MoreHorizontalIcon className="size-3.5" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end">
                          {columns
                            .filter((target) => target.id !== column.id)
                            .map((target) => (
                              <DropdownMenuItem
                                key={target.id}
                                onClick={() => moveRow(row, target.id)}
                              >
                                Verschieben nach „{target.label}“
                              </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                  {otherProperties.map((property) => (
                    <PropertyValueDisplay
                      key={property.id}
                      property={property}
                      value={propertyValue(row, property.id)}
                    />
                  ))}
                </div>
              ))}

              {readOnly ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start text-muted-foreground"
                  onClick={() =>
                    createRow.mutate({
                      title: 'Unbenannt',
                      values:
                        column.id === NO_VALUE_COLUMN
                          ? []
                          : [{ propertyId: groupProperty.id, value: column.id }],
                    })
                  }
                >
                  <PlusIcon /> Neue Karte
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
