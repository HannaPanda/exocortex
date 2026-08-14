'use client';

import { ExternalLinkIcon } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import {
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseRowPropertyValue,
} from '@exocortex/contracts';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@exocortex/ui';

import { PropertyCell } from './cells';
import { PROPERTY_TYPE_LABELS } from './property-types';

interface RowPeekSheetProps {
  workspaceId: string;
  /** The row to show, or `null` when the sheet is closed. */
  row: DatabaseRow | null;
  properties: DatabaseProperty[];
  readOnly: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (propertyId: string, value: DatabaseRowPropertyValue['value']) => void;
}

/**
 * One row, read top to bottom instead of left to right.
 *
 * A table trades completeness for overview: every column is a compromise
 * between the width it has and the width its values need. This sheet is the
 * other half of that trade. It shows all properties of a single row stacked, at
 * full sheet width and with six lines of room each, so no value is ever only
 * reachable by widening a column. Editing goes through the same
 * `PropertyCell`s as the table, so nothing is a read-only copy that can drift.
 */
export function RowPeekSheet({
  workspaceId,
  row,
  properties,
  readOnly,
  onOpenChange,
  onChange,
}: RowPeekSheetProps) {
  return (
    <Sheet open={row !== null} onOpenChange={onOpenChange}>
      {row === null ? null : (
        <SheetContent side="right" className="w-full max-w-xl" data-testid="row-peek">
          <SheetHeader className="border-b border-border pr-10">
            <SheetTitle className="text-lg break-words">{row.document.title}</SheetTitle>
            <SheetDescription>
              <Link
                href={`/arbeitsbereich/${workspaceId}/seite/${row.document.id}`}
                className="inline-flex items-center gap-1 hover:text-foreground"
              >
                <ExternalLinkIcon className="size-3.5" aria-hidden />
                Als Seite öffnen
              </Link>
            </SheetDescription>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            {properties.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Diese Datenbank hat noch keine Eigenschaften.
              </p>
            ) : null}
            {properties.map((property) => (
              <div key={property.id} className="grid grid-cols-[9rem_1fr] items-start gap-2">
                <div className="flex flex-col gap-0.5 pt-1.5">
                  <span className="text-sm font-medium break-words">{property.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {PROPERTY_TYPE_LABELS[property.type]}
                  </span>
                </div>
                <PropertyCell
                  property={property}
                  value={
                    row.values.find((entry) => entry.propertyId === property.id)?.value ?? null
                  }
                  readOnly={readOnly}
                  // The sheet is where a long value must be readable in full,
                  // so it always uses the most generous clamp.
                  rowHeight="tall"
                  onChange={(next) => onChange(property.id, next)}
                />
              </div>
            ))}
          </div>
        </SheetContent>
      )}
    </Sheet>
  );
}
