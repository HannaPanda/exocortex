'use client';

import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { type DatabaseProperty, type DatabaseRow, type DatabaseView } from '@exocortex/contracts';
import {
  Button,
  EmptyState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useCreateDatabaseRow, useDatabaseRows, useUpdateDatabaseRowValues } from '@/lib/api/database-queries';

import { AddPropertyButton } from './add-property-button';
import { PropertyCell } from './cells';
import { PropertyMenu } from './property-menu';

interface TableViewProps {
  workspaceId: string;
  documentId: string;
  view: DatabaseView;
  properties: DatabaseProperty[];
  readOnly: boolean;
}

export function TableView({ workspaceId, documentId, view, properties, readOnly }: TableViewProps) {
  const rowsQuery = useDatabaseRows(documentId, { viewId: view.id, limit: 100 });
  const createRow = useCreateDatabaseRow(documentId);
  const updateValues = useUpdateDatabaseRowValues(documentId);

  if (rowsQuery.isPending) return <LoadingState variant="skeleton" rows={4} label="Zeilen werden geladen" />;
  if (rowsQuery.isError) {
    return <EmptyState title="Zeilen nicht geladen" description="Bitte versuche es erneut." />;
  }

  const rows = rowsQuery.data.rows;

  const setValue = (row: DatabaseRow, propertyId: string, value: DatabaseRow['values'][number]['value']) => {
    updateValues.mutate({ rowId: row.document.id, request: { values: [{ propertyId, value }] } });
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="min-w-48">Name</TableHead>
            {properties.map((property) => (
              <TableHead key={property.id} className="min-w-40">
                <PropertyMenu documentId={documentId} property={property} readOnly={readOnly} />
              </TableHead>
            ))}
            {readOnly ? null : (
              <TableHead className="w-10">
                <AddPropertyButton documentId={documentId} />
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.document.id} data-testid={`database-row-${row.document.id}`}>
              <TableCell>
                <Link
                  href={`/arbeitsbereich/${workspaceId}/seite/${row.document.id}`}
                  className="block truncate px-1.5 py-1 hover:underline"
                >
                  {row.document.title}
                </Link>
              </TableCell>
              {properties.map((property) => {
                const cellValue = row.values.find((entry) => entry.propertyId === property.id)?.value ?? null;
                return (
                  <TableCell key={property.id} className="p-0">
                    <PropertyCell
                      property={property}
                      value={cellValue}
                      readOnly={readOnly}
                      onChange={(next) => setValue(row, property.id, next)}
                    />
                  </TableCell>
                );
              })}
              {readOnly ? null : <TableCell />}
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
          onClick={() => createRow.mutate({ title: 'Unbenannt', values: [] })}
        >
          <PlusIcon /> Neue Zeile
        </Button>
      )}

      {rows.length === 0 ? (
        <EmptyState title="Noch keine Zeilen" description="Lege die erste Zeile für diese Datenbank an." />
      ) : null}
    </div>
  );
}
