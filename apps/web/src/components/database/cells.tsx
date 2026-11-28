'use client';

import { CheckIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  type DatabaseProperty,
  type DatabaseRow,
  type DatabaseRowHeight,
  type DatabaseRowPropertyValue,
} from '@exocortex/contracts';
import { Checkbox } from '@exocortex/ui';

import { DateCell, useDateValueFormat } from './date-cell';
import { FilesCell } from './files-cell';
import { MultiSelectCell, OptionBadge, SelectCell } from './option-cells';
import { PeopleValueDisplay, PersonCell } from './person-cell';
import {
  ARRAY_PROPERTY_TYPES,
  COMPUTED_PROPERTY_TYPES,
  DERIVED_PROPERTY_TYPE_SET,
} from './property-types';
import { ReadonlyCell, useComputedValueFormat } from './readonly-cell';
import { RelationCell, RelationValueDisplay } from './relation-cell';
import { NumberCell, TextCell } from './text-cells';

export type CellValue = DatabaseRowPropertyValue['value'];

export interface PropertyCellProps {
  property: DatabaseProperty;
  value: CellValue;
  onChange: (value: CellValue) => void;
  readOnly: boolean;
  /** Row density of the table view showing this cell. Defaults to one line. */
  rowHeight?: DatabaseRowHeight;
  /**
   * The row the cell belongs to. A FILES cell uploads into it and reads its
   * files' names from it (issue #245); the other cells do not need it.
   */
  row?: DatabaseRow;
  /**
   * The workspace, where there is no single row to read it from: the dialog
   * that sets one value for several rows (issue #244). A PERSON cell lists its
   * members from it (issue #314).
   */
  workspaceId?: string;
}

/** The types whose value names accounts, shown by name (issue #314). */
const PERSON_VALUED_TYPES = new Set<DatabaseProperty['type']>([
  'PERSON',
  'CREATED_BY',
  'UPDATED_BY',
]);

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
  row,
  workspaceId,
}: PropertyCellProps) {
  const cellKey = JSON.stringify(value);
  const shared = { property, value, onChange, readOnly, rowHeight };
  // Who made or changed the row is computed, so it is never edited; it reads
  // like a Person cell, by name. A PERSON cell is not keyed on its value: its
  // picker keeps a draft while it is open, and a refetch must not close it.
  if (PERSON_VALUED_TYPES.has(property.type)) {
    return (
      <PersonCell
        {...shared}
        readOnly={readOnly || property.type !== 'PERSON'}
        row={row}
        workspaceId={workspaceId}
      />
    );
  }
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
    case 'FILES':
      // Not keyed on the value: an upload in flight lives in the cell, and a
      // second file arriving must not remount it away (issue #245). The cell
      // holds no draft of the value that would need the remount.
      return <FilesCell {...shared} row={row} />;
    default:
      return <TextCell key={cellKey} {...shared} />;
  }
}

function CheckboxCell({ value, onChange, readOnly }: PropertyCellProps) {
  const t = useTranslations('database.cells');
  return (
    <div className="flex min-h-8 items-center px-1.5">
      <Checkbox
        checked={value === true}
        disabled={readOnly}
        aria-label={t('checkbox')}
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
  row,
}: {
  property: DatabaseProperty;
  value: CellValue;
  /**
   * The row the value belongs to: its files, so a FILES value reads as names
   * (issue #245), and its people, so a Person value does (issue #314).
   */
  row?: DatabaseRow;
}) {
  const t = useTranslations('database.cells');
  const formatDateValue = useDateValueFormat();
  const formatComputedValue = useComputedValueFormat();
  if (value === null || (Array.isArray(value) && value.length === 0)) return null;

  if (PERSON_VALUED_TYPES.has(property.type)) {
    return <PeopleValueDisplay value={value} row={row} />;
  }

  if (COMPUTED_PROPERTY_TYPES.has(property.type) || DERIVED_PROPERTY_TYPE_SET.has(property.type)) {
    return (
      <span className="truncate text-xs text-muted-foreground">
        {formatComputedValue(property, value)}
      </span>
    );
  }

  if (property.type === 'CHECKBOX') {
    return value === true ? (
      <CheckIcon className="size-3.5 text-primary-text" aria-label={t('checked')} />
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
  if (property.type === 'FILES' && Array.isArray(value)) {
    return <FileNamesDisplay ids={value} row={row} />;
  }
  if (Array.isArray(value)) {
    return <span className="text-xs text-muted-foreground">{value.join(', ')}</span>;
  }
  return <span className="truncate text-xs text-muted-foreground">{String(value)}</span>;
}

/** A FILES value on a card: the names of the files that still exist. */
function FileNamesDisplay({ ids, row }: { ids: readonly string[]; row: DatabaseRow | undefined }) {
  const names = new Map((row?.files ?? []).map((file) => [file.id, file.filename] as const));
  const shown = ids.flatMap((id) => {
    const name = names.get(id);
    return name === undefined ? [] : [name];
  });
  if (shown.length === 0) return null;
  return (
    <span className="truncate text-xs text-muted-foreground" title={shown.join(', ')}>
      {shown.join(', ')}
    </span>
  );
}
