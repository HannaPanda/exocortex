'use client';

import { CopyIcon, PencilLineIcon, SparklesIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { type DatabaseProperty, type DatabaseRow } from '@exocortex/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@exocortex/ui';

import { type CellValue, PropertyCell } from './cells';
import { COMPUTED_PROPERTY_TYPES, DERIVED_PROPERTY_TYPE_SET } from './property-types';

/**
 * Columns a selection can be given one value for. Computed columns have no
 * value to give, and a file belongs to the row it was uploaded onto (ADR-098),
 * so the same file cannot go into twelve rows.
 */
export function bulkWritableProperties(properties: readonly DatabaseProperty[]) {
  return properties.filter(
    (property) =>
      !COMPUTED_PROPERTY_TYPES.has(property.type) &&
      !DERIVED_PROPERTY_TYPE_SET.has(property.type) &&
      property.type !== 'FILES',
  );
}

/** The value the selected rows share in a column, or nothing when they differ. */
function sharedValue(rows: readonly DatabaseRow[], propertyId: string): CellValue {
  const values = rows.map(
    (row) => row.values.find((entry) => entry.propertyId === propertyId)?.value ?? null,
  );
  const first = JSON.stringify(values[0] ?? null);
  return values.every((value) => JSON.stringify(value) === first) ? (values[0] ?? null) : null;
}

/**
 * The bar above a table while rows are selected (issue #244): how many, and
 * what can be done to all of them at once.
 */
export function RowSelectionBar({
  rows,
  properties,
  busy,
  editing,
  onEdit,
  onSetValue,
  aiColumns = [],
  onAiFill,
  onDuplicate,
  onTrash,
  onClear,
}: {
  /** Columns with an AI instruction the selection can be filled in (issue #237). */
  aiColumns?: readonly DatabaseProperty[];
  onAiFill?: (property: DatabaseProperty) => void;
  /** The selected rows, in table order. */
  rows: readonly DatabaseRow[];
  properties: readonly DatabaseProperty[];
  busy: boolean;
  /** The column whose value is being set for every selected row, if any. */
  editing: DatabaseProperty | null;
  onEdit: (property: DatabaseProperty | null) => void;
  onSetValue: (propertyId: string, value: CellValue) => void;
  onDuplicate: () => void;
  onTrash: () => void;
  onClear: () => void;
}) {
  const t = useTranslations('database.selection');
  const writable = bulkWritableProperties(properties);

  return (
    <div
      role="toolbar"
      aria-label={t('toolbar')}
      data-testid="row-selection-bar"
      className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/40 px-2 py-1"
    >
      <span className="px-1.5 text-sm font-medium" aria-live="polite" data-testid="selection-count">
        {t('count', { count: rows.length })}
      </span>
      {writable.length === 0 ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" disabled={busy} data-testid="selection-set-value">
                <PencilLineIcon /> {t('setValue')}
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            {writable.map((property) => (
              <DropdownMenuItem
                key={property.id}
                data-testid={`selection-property-${property.id}`}
                onClick={() => onEdit(property)}
              >
                {property.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {aiColumns.length === 0 || onAiFill === undefined ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" disabled={busy} data-testid="selection-ai-fill">
                <SparklesIcon /> {t('aiFill')}
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            {aiColumns.map((property) => (
              <DropdownMenuItem
                key={property.id}
                data-testid={`selection-ai-fill-${property.id}`}
                onClick={() => onAiFill(property)}
              >
                {property.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        data-testid="selection-duplicate"
        onClick={onDuplicate}
      >
        <CopyIcon /> {t('duplicate')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        className="text-destructive-text hover:text-destructive-text"
        data-testid="selection-trash"
        onClick={onTrash}
      >
        <Trash2Icon /> {t('trash')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto"
        data-testid="selection-clear"
        onClick={onClear}
      >
        <XIcon /> {t('clear')}
      </Button>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) onEdit(null);
        }}
      >
        <DialogContent data-testid="selection-value-dialog">
          <DialogHeader>
            <DialogTitle>{t('setValueTitle', { name: editing?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('setValueDescription', { count: rows.length })}
            </DialogDescription>
          </DialogHeader>
          {editing === null ? null : (
            <div className="rounded-md border border-border">
              <PropertyCell
                property={editing}
                value={sharedValue(rows, editing.id)}
                readOnly={busy}
                workspaceId={rows[0]?.document.workspaceId}
                onChange={(value) => onSetValue(editing.id, value)}
              />
            </div>
          )}
          <DialogFooter>
            <Button data-testid="selection-value-done" onClick={() => onEdit(null)}>
              {t('done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
