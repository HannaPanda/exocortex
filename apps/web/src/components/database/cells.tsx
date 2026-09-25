'use client';

import { CheckIcon } from 'lucide-react';

import {
  type DatabaseProperty,
  type DatabaseRowHeight,
  type DatabaseRowPropertyValue,
} from '@exocortex/contracts';
import { Checkbox } from '@exocortex/ui';

import { DateCell, formatDateValue } from './date-cell';
import { MultiSelectCell, OptionBadge, SelectCell } from './option-cells';
import {
  ARRAY_PROPERTY_TYPES,
  COMPUTED_PROPERTY_TYPES,
  DERIVED_PROPERTY_TYPE_SET,
} from './property-types';
import { ReadonlyCell } from './readonly-cell';
import { RelationCell, RelationValueDisplay } from './relation-cell';
import { IdListCell, NumberCell, TextCell } from './text-cells';

export type CellValue = DatabaseRowPropertyValue['value'];

export interface PropertyCellProps {
  property: DatabaseProperty;
  value: CellValue;
  onChange: (value: CellValue) => void;
  readOnly: boolean;
  /** Row density of the table view showing this cell. Defaults to one line. */
  rowHeight?: DatabaseRowHeight;
}

/**
 * Dispatches to the editor for `property.type`. One switch, not ten call sites.
 *
 * `key={JSON.stringify(value)}` remounts the cell whenever the committed
 * server value changes (this edit's own round-trip, or another user's edit
 * arriving through a refetch) — the same "remount instead of an effect"
 * pattern `DocumentTitleInput` uses, so local draft state (in `TextCell`
 * etc.) never needs a `useEffect` to resync with props.
 */
export function PropertyCell({
  property,
  value,
  onChange,
  readOnly,
  rowHeight = 'short',
}: PropertyCellProps) {
  const cellKey = JSON.stringify(value);
  const shared = { property, value, onChange, readOnly, rowHeight };
  // A rollup and a formula are computed by the query engine on every read, so
  // there is nothing here to edit: the way to change one is to change the
  // linked rows, or the formula itself in the column menu.
  if (COMPUTED_PROPERTY_TYPES.has(property.type) || DERIVED_PROPERTY_TYPE_SET.has(property.type)) {
    return <ReadonlyCell property={property} value={value} rowHeight={rowHeight} />;
  }
  switch (property.type) {
    case 'RELATION':
      return <RelationCell key={cellKey} {...shared} />;
    case 'CHECKBOX':
      return <CheckboxCell key={cellKey} {...shared} />;
    case 'NUMBER':
      return <NumberCell key={cellKey} {...shared} />;
    case 'DATE':
      return <DateCell key={cellKey} {...shared} />;
    case 'SELECT':
      return <SelectCell key={cellKey} {...shared} />;
    case 'MULTI_SELECT':
      return <MultiSelectCell key={cellKey} {...shared} />;
    case 'PERSON':
    case 'FILES':
      return <IdListCell key={cellKey} {...shared} />;
    default:
      return <TextCell key={cellKey} {...shared} />;
  }
}

function CheckboxCell({ value, onChange, readOnly }: PropertyCellProps) {
  return (
    <div className="flex min-h-8 items-center px-1.5">
      <Checkbox
        checked={value === true}
        disabled={readOnly}
        aria-label="Kontrollkästchen"
        onCheckedChange={(checked) => onChange(checked)}
      />
    </div>
  );
}

export function isArrayProperty(property: DatabaseProperty): boolean {
  return ARRAY_PROPERTY_TYPES.has(property.type);
}

/**
 * Compact, non-interactive value display for Board/Gallery card summaries.
 * Deliberately not `<PropertyCell readOnly>`: a card is a summary, not a
 * disabled form, so a DATE value reads as "20.08.2026" here instead of a
 * picker button with its calendar icon still showing through.
 */
export function PropertyValueDisplay({
  property,
  value,
}: {
  property: DatabaseProperty;
  value: CellValue;
}) {
  if (value === null || (Array.isArray(value) && value.length === 0)) return null;

  if (property.type === 'CHECKBOX') {
    return value === true ? (
      <CheckIcon className="size-3.5 text-primary-text" aria-label="Erledigt" />
    ) : null;
  }
  if (property.type === 'DATE') {
    const formatted = formatDateValue(property, value);
    return formatted === null ? null : (
      <span className="text-xs text-muted-foreground">{formatted}</span>
    );
  }
  if (property.type === 'RELATION') {
    return <RelationValueDisplay property={property} value={value} />;
  }
  if (property.type === 'SELECT' && typeof value === 'string') {
    return <OptionBadge optionId={value} property={property} />;
  }
  if (property.type === 'MULTI_SELECT' && Array.isArray(value)) {
    return (
      <div className="flex flex-wrap gap-1">
        {value.map((optionId) => (
          <OptionBadge key={optionId} optionId={optionId} property={property} />
        ))}
      </div>
    );
  }
  if (Array.isArray(value)) {
    return <span className="text-xs text-muted-foreground">{value.join(', ')}</span>;
  }
  return <span className="truncate text-xs text-muted-foreground">{String(value)}</span>;
}
