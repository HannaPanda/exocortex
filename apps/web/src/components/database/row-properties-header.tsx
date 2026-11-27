'use client';

import { ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabaseProperty, type DatabaseRow } from '@exocortex/contracts';
import { Button, cn } from '@exocortex/ui';

import { useDocumentRow, useUpdateDatabaseRowValues } from '@/lib/api/database-queries';
import { usePersistentState } from '@/lib/use-persistent-state';

import { type CellValue, PropertyCell } from './cells';
import { usePropertyTypeLabel } from './property-types';
import { layoutRowHeader } from './row-header-layout';

const parseExpanded = (raw: string): boolean => JSON.parse(raw) === true;

interface RowPropertiesHeaderProps {
  /** The database the page is a row of (`DocumentDetail.parentId`). */
  collectionDocumentId: string;
  /** The page itself, which is the row (ADR-011). */
  rowId: string;
  readOnly: boolean;
}

/**
 * A row's values under its title, the way Notion shows a database page (issue
 * #254).
 *
 * Nothing here is a second copy of the row. The values are read from the same
 * row the table reads (`GET /api/documents/:id/row`, which also brings the
 * columns, so a page shared on its own can show them) and written through the
 * same `PATCH .../values`; every field is the table's own `PropertyCell`, so a
 * date has the table's day and time pickers, a relation the table's picker, and
 * a rollup or formula the table's read-only rendering. The page's text (its Yjs
 * state) is never touched.
 *
 * Renders nothing while the row loads, and nothing for a database
 * without columns: the header is for the values, and a page that has none
 * should look like any other page.
 */
export function RowPropertiesHeader({
  collectionDocumentId,
  rowId,
  readOnly,
}: RowPropertiesHeaderProps) {
  const t = useTranslations('database.rowHeader');
  const row = useDocumentRow(rowId);
  // A failed refetch keeps the values it already has; only a first load that
  // failed says so, in one quiet line rather than a block above the text.
  if (row.isError && row.data === undefined) {
    return (
      <p className="mb-6 text-sm text-muted-foreground" role="alert">
        {t('unavailable')}{' '}
        <button
          type="button"
          className="underline hover:text-foreground"
          onClick={() => void row.refetch()}
        >
          {t('retry')}
        </button>
      </p>
    );
  }
  if (row.data === undefined || row.data.row === null || row.data.properties.length === 0) {
    return null;
  }
  return (
    <RowPropertiesList
      collectionDocumentId={collectionDocumentId}
      row={row.data.row}
      properties={row.data.properties}
      readOnly={readOnly}
    />
  );
}

function RowPropertiesList({
  collectionDocumentId,
  row,
  properties,
  readOnly,
}: {
  collectionDocumentId: string;
  row: DatabaseRow;
  properties: DatabaseProperty[];
  readOnly: boolean;
}) {
  const t = useTranslations('database.rowHeader');
  const typeLabel = usePropertyTypeLabel();
  const updateValues = useUpdateDatabaseRowValues(collectionDocumentId);
  // Remembered per database and per browser: whoever unfolds the long schema
  // of one database usually wants it open on its next row too, and another
  // database with forty columns should not open just because this one is.
  const [expanded, setExpanded] = usePersistentState(
    `exocortex.rowHeader.expanded.${collectionDocumentId}`,
    false,
    parseExpanded,
  );
  const listId = React.useId();

  const valueOf = (propertyId: string): CellValue | undefined =>
    row.values.find((entry) => entry.propertyId === propertyId)?.value;
  const layout = layoutRowHeader({ properties, valueOf, readOnly });
  const visible = expanded ? properties : layout.shown;
  const foldable = layout.folded.length > 0;

  if (visible.length === 0 && !foldable) return null;

  return (
    <section
      aria-label={t('label')}
      className="mb-6 flex flex-col gap-0.5 border-b border-border pb-4"
      data-testid="row-properties-header"
    >
      <div id={listId} className="flex flex-col gap-0.5">
        {visible.map((property) => (
          <div
            key={property.id}
            role="group"
            aria-label={property.name}
            className="grid grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)] items-start gap-x-3"
            data-testid={`row-header-property-${property.id}`}
          >
            <span
              className="truncate pt-1.5 text-sm text-muted-foreground"
              title={`${property.name} · ${typeLabel(property.type)}`}
            >
              {property.name}
            </span>
            <div className="min-w-0">
              <PropertyCell
                property={property}
                value={valueOf(property.id) ?? null}
                readOnly={readOnly}
                // A page has room the table cell does not: a long value is
                // shown at the most generous clamp, as in the row sheet.
                rowHeight="tall"
                onChange={(next) => {
                  void updateValues.mutateAsync({
                    rowId: row.document.id,
                    request: { values: [{ propertyId: property.id, value: next }] },
                  });
                }}
              />
            </div>
          </div>
        ))}
      </div>
      {foldable ? (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 self-start text-muted-foreground"
          aria-expanded={expanded}
          aria-controls={listId}
          data-testid="row-header-toggle"
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDownIcon
            aria-hidden
            className={cn('transition-transform', expanded ? 'rotate-180' : undefined)}
          />
          {expanded ? t('fewer') : t('more', { count: layout.folded.length })}
        </Button>
      ) : null}
    </section>
  );
}
