'use client';

import { CheckIcon, XIcon } from 'lucide-react';
import * as React from 'react';

import {
  type DatabaseProperty,
  type DatabaseRowPropertyValue,
} from '@exocortex/contracts';
import {
  Badge,
  Checkbox,
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@exocortex/ui';

import {
  ARRAY_PROPERTY_TYPES,
  COMPUTED_PROPERTY_TYPES,
  OPTION_COLOR_BG_CLASS,
  OPTION_COLOR_TEXT_CLASS,
} from './property-types';

type CellValue = DatabaseRowPropertyValue['value'];

export interface PropertyCellProps {
  property: DatabaseProperty;
  value: CellValue;
  onChange: (value: CellValue) => void;
  readOnly: boolean;
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
export function PropertyCell({ property, value, onChange, readOnly }: PropertyCellProps) {
  const cellKey = JSON.stringify(value);
  if (COMPUTED_PROPERTY_TYPES.has(property.type)) {
    return <ReadonlyCell property={property} value={value} />;
  }
  switch (property.type) {
    case 'CHECKBOX':
      return <CheckboxCell key={cellKey} property={property} value={value} onChange={onChange} readOnly={readOnly} />;
    case 'NUMBER':
      return <NumberCell key={cellKey} property={property} value={value} onChange={onChange} readOnly={readOnly} />;
    case 'DATE':
      return <DateCell key={cellKey} property={property} value={value} onChange={onChange} readOnly={readOnly} />;
    case 'SELECT':
      return <SelectCell key={cellKey} property={property} value={value} onChange={onChange} readOnly={readOnly} />;
    case 'MULTI_SELECT':
      return (
        <MultiSelectCell key={cellKey} property={property} value={value} onChange={onChange} readOnly={readOnly} />
      );
    case 'PERSON':
    case 'FILES':
      return <IdListCell key={cellKey} property={property} value={value} onChange={onChange} readOnly={readOnly} />;
    default:
      return <TextCell key={cellKey} property={property} value={value} onChange={onChange} readOnly={readOnly} />;
  }
}

function commitOnEnterOrBlur(onCommit: () => void) {
  return {
    onBlur: onCommit,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') event.currentTarget.blur();
      if (event.key === 'Escape') event.currentTarget.blur();
    },
  };
}

function TextCell({ property, value, onChange, readOnly }: PropertyCellProps) {
  // No effect to resync `draft` when `value` changes: `PropertyCell` keys
  // every cell on its committed value, so a server-driven change (this
  // mutation's own success, another user's edit) remounts the cell instead
  // (same pattern as `DocumentTitleInput` in document-view.tsx).
  const [draft, setDraft] = React.useState(typeof value === 'string' ? value : '');

  const inputType = property.type === 'EMAIL' ? 'email' : property.type === 'URL' ? 'url' : 'text';

  return (
    <Input
      type={inputType}
      value={draft}
      readOnly={readOnly}
      placeholder="Leer"
      className="h-8 border-transparent bg-transparent px-1.5 shadow-none hover:border-input focus-visible:ring-1"
      onChange={(event) => setDraft(event.target.value)}
      {...commitOnEnterOrBlur(() => {
        const next = draft.trim();
        if (next !== (typeof value === 'string' ? value : '')) onChange(next.length === 0 ? null : next);
      })}
    />
  );
}

function NumberCell({ value, onChange, readOnly }: PropertyCellProps) {
  const [draft, setDraft] = React.useState(typeof value === 'number' ? String(value) : '');

  return (
    <Input
      type="number"
      value={draft}
      readOnly={readOnly}
      placeholder="Leer"
      className="h-8 border-transparent bg-transparent px-1.5 text-right shadow-none hover:border-input focus-visible:ring-1"
      onChange={(event) => setDraft(event.target.value)}
      {...commitOnEnterOrBlur(() => {
        if (draft.trim().length === 0) {
          if (value !== null) onChange(null);
          return;
        }
        const parsed = Number(draft);
        if (Number.isFinite(parsed) && parsed !== value) onChange(parsed);
      })}
    />
  );
}

function CheckboxCell({ value, onChange, readOnly }: PropertyCellProps) {
  return (
    <div className="flex h-8 items-center px-1.5">
      <Checkbox
        checked={value === true}
        disabled={readOnly}
        aria-label="Kontrollkästchen"
        onCheckedChange={(checked) => onChange(checked)}
      />
    </div>
  );
}

function isoDateOnly(value: CellValue): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, 10);
}

function DateCell({ value, onChange, readOnly }: PropertyCellProps) {
  return (
    <Input
      type="date"
      defaultValue={isoDateOnly(value)}
      readOnly={readOnly}
      className="h-8 border-transparent bg-transparent px-1.5 shadow-none hover:border-input focus-visible:ring-1"
      onChange={(event) => {
        const next = event.target.value;
        onChange(next.length === 0 ? null : new Date(`${next}T00:00:00.000Z`).toISOString());
      }}
    />
  );
}

function OptionBadge({ optionId, property }: { optionId: string; property: DatabaseProperty }) {
  const option = property.options.find((entry) => entry.id === optionId);
  if (option === undefined) return null;
  return (
    <Badge
      variant="outline"
      className={cn('border-transparent', OPTION_COLOR_BG_CLASS[option.color], OPTION_COLOR_TEXT_CLASS[option.color])}
    >
      {option.label}
    </Badge>
  );
}

function SelectCell({ property, value, onChange, readOnly }: PropertyCellProps) {
  const [open, setOpen] = React.useState(false);
  const selected = typeof value === 'string' ? value : null;

  if (readOnly) {
    return <div className="flex h-8 items-center px-1.5">{selected !== null ? <OptionBadge optionId={selected} property={property} /> : null}</div>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex h-8 w-full items-center gap-1 rounded-md px-1.5 text-left hover:bg-accent-solid"
          >
            {selected !== null ? <OptionBadge optionId={selected} property={property} /> : <span className="text-sm text-muted-foreground">Leer</span>}
          </button>
        }
      />
      <PopoverContent align="start" className="w-56 p-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent-solid"
          onClick={() => {
            onChange(null);
            setOpen(false);
          }}
        >
          <XIcon className="size-3.5 text-muted-foreground" /> Keine Auswahl
        </button>
        {property.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent-solid"
            onClick={() => {
              onChange(option.id);
              setOpen(false);
            }}
          >
            <Badge
              variant="outline"
              className={cn('border-transparent', OPTION_COLOR_BG_CLASS[option.color], OPTION_COLOR_TEXT_CLASS[option.color])}
            >
              {option.label}
            </Badge>
            {option.id === selected ? <CheckIcon className="size-3.5" /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function MultiSelectCell({ property, value, onChange, readOnly }: PropertyCellProps) {
  const [open, setOpen] = React.useState(false);
  const selected = Array.isArray(value) ? value : [];

  const toggle = (optionId: string) => {
    onChange(
      selected.includes(optionId) ? selected.filter((entry) => entry !== optionId) : [...selected, optionId],
    );
  };

  const badges = (
    <div className="flex flex-wrap gap-1">
      {selected.map((optionId) => (
        <OptionBadge key={optionId} optionId={optionId} property={property} />
      ))}
    </div>
  );

  if (readOnly) {
    return <div className="flex h-8 items-center px-1.5">{badges}</div>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button type="button" className="flex h-8 w-full items-center px-1.5 text-left hover:bg-accent-solid">
            {selected.length > 0 ? badges : <span className="text-sm text-muted-foreground">Leer</span>}
          </button>
        }
      />
      <PopoverContent align="start" className="w-56 p-1">
        {property.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent-solid"
            onClick={() => toggle(option.id)}
          >
            <Badge
              variant="outline"
              className={cn('border-transparent', OPTION_COLOR_BG_CLASS[option.color], OPTION_COLOR_TEXT_CLASS[option.color])}
            >
              {option.label}
            </Badge>
            {selected.includes(option.id) ? <CheckIcon className="size-3.5" /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * PERSON and FILES store an array of ids (user ids / attachment ids). A
 * proper member picker or file browser is a separate feature; this is the
 * honest minimal editor for the array itself, entered as a comma-separated
 * list, so the property round-trips completely through the API.
 */
function IdListCell({ value, onChange, readOnly }: PropertyCellProps) {
  const current = Array.isArray(value) ? value : [];
  const [draft, setDraft] = React.useState(current.join(', '));

  return (
    <Input
      value={draft}
      readOnly={readOnly}
      placeholder="IDs, durch Komma getrennt"
      className="h-8 border-transparent bg-transparent px-1.5 font-mono text-xs shadow-none hover:border-input focus-visible:ring-1"
      onChange={(event) => setDraft(event.target.value)}
      {...commitOnEnterOrBlur(() => {
        const next = draft
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        onChange(next.length === 0 ? null : next);
      })}
    />
  );
}

function formatComputed(property: DatabaseProperty, value: CellValue): string {
  if (value === null) return '—';
  if (property.type === 'CREATED_TIME' || property.type === 'UPDATED_TIME') {
    return new Date(String(value)).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  }
  return String(value);
}

function ReadonlyCell({ property, value }: { property: DatabaseProperty; value: CellValue }) {
  return (
    <div className="flex h-8 items-center px-1.5 text-sm text-muted-foreground" data-testid="readonly-cell">
      {formatComputed(property, value)}
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
 * native `<input type="date">` with its browser-locale chrome and calendar
 * icon still showing through.
 */
export function PropertyValueDisplay({ property, value }: { property: DatabaseProperty; value: CellValue }) {
  if (value === null || (Array.isArray(value) && value.length === 0)) return null;

  if (property.type === 'CHECKBOX') {
    return value === true ? <CheckIcon className="size-3.5 text-primary-text" aria-label="Erledigt" /> : null;
  }
  if (property.type === 'DATE' && typeof value === 'string') {
    return <span className="text-xs text-muted-foreground">{new Date(value).toLocaleDateString('de-DE')}</span>;
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
