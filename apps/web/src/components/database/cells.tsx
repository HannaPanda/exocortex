'use client';

import { CheckIcon, XIcon } from 'lucide-react';
import * as React from 'react';

import {
  type DatabaseProperty,
  type DatabaseRowHeight,
  type DatabaseRowPropertyValue,
  parseDatePropertyConfig,
} from '@exocortex/contracts';
import {
  Badge,
  Checkbox,
  cn,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Textarea,
} from '@exocortex/ui';

import {
  ARRAY_PROPERTY_TYPES,
  COMPUTED_PROPERTY_TYPES,
  DERIVED_PROPERTY_TYPE_SET,
  OPTION_COLOR_BG_CLASS,
  OPTION_COLOR_TEXT_CLASS,
} from './property-types';
import { RelationCell, RelationValueDisplay } from './relation-cell';
import { ROW_HEIGHT_BOX_CLAMP, ROW_HEIGHT_LINE_CLAMP } from './table-columns';

type CellValue = DatabaseRowPropertyValue['value'];

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

function commitOnEnterOrBlur(onCommit: () => void) {
  return {
    onBlur: onCommit,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') event.currentTarget.blur();
      if (event.key === 'Escape') event.currentTarget.blur();
    },
  };
}

const CELL_BOX = 'flex min-h-8 w-full items-start px-1.5 py-1.5 text-left text-sm';
const CELL_INTERACTIVE =
  'rounded-md hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring outline-none';

/**
 * A text value that can be longer than its column, in two states.
 *
 * Collapsed it is a button showing the value clamped to the row height, so a
 * long value neither breaks the grid nor silently disappears behind
 * `overflow: hidden`. Expanded it is an overlay anchored to the cell, at least
 * as wide as the column and as tall as it needs, holding the complete value.
 *
 * The overlay, rather than a growing cell, is what keeps the table still: rows
 * below do not shift while typing, and the editor may be far larger than the
 * column. Closing it commits, which is the same contract as the single-line
 * cells' commit-on-blur.
 */
function ExpandableTextCell({
  value,
  onChange,
  readOnly,
  rowHeight = 'short',
  multiline,
  inputType = 'text',
  format,
  parse = (raw) => (raw.trim().length === 0 ? null : raw.trim()),
  monospace = false,
  placeholder = 'Leer',
}: PropertyCellProps & {
  multiline: boolean;
  inputType?: 'text' | 'email' | 'url';
  /** Committed value to editable text. */
  format: (value: CellValue) => string;
  /** Editable text back to a committed value. */
  parse?: (raw: string) => CellValue;
  monospace?: boolean;
  placeholder?: string;
}) {
  // No effect to resync `draft` when `value` changes: `PropertyCell` keys every
  // cell on its committed value, so a server-driven change (this mutation's own
  // success, another user's edit) remounts the cell instead (same pattern as
  // `DocumentTitleInput` in document-view.tsx).
  const committed = format(value);
  const [draft, setDraft] = React.useState(committed);
  const [open, setOpen] = React.useState(false);

  const commit = (): void => {
    if (draft === committed) return;
    onChange(parse(draft));
  };

  const preview =
    committed.length > 0 ? (
      <span
        title={committed}
        className={cn(
          'w-full break-words whitespace-pre-wrap',
          monospace && 'font-mono text-xs',
          ROW_HEIGHT_LINE_CLAMP[rowHeight],
        )}
      >
        {committed}
      </span>
    ) : (
      <span className="text-muted-foreground">{placeholder}</span>
    );

  if (readOnly) {
    return <div className={CELL_BOX}>{preview}</div>;
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Escape, a click outside and the keyboard shortcut all end up here,
        // so there is exactly one commit path.
        if (!next) commit();
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(CELL_BOX, CELL_INTERACTIVE)}
            data-testid="cell-expand"
          >
            {preview}
          </button>
        }
      />
      <PopoverContent
        align="start"
        className="w-[max(var(--anchor-width),20rem)] max-w-[min(90vw,36rem)] p-1.5"
      >
        {multiline ? (
          <Textarea
            autoFocus
            value={draft}
            rows={4}
            placeholder={placeholder}
            className={cn('max-h-[40vh] resize-none text-sm', monospace && 'font-mono text-xs')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter belongs to the text here, so committing needs a modifier.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) setOpen(false);
            }}
          />
        ) : (
          <Input
            autoFocus
            type={inputType}
            value={draft}
            placeholder={placeholder}
            className={cn('text-sm', monospace && 'font-mono text-xs')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setOpen(false);
            }}
          />
        )}
        <p className="px-1 pt-1 text-micro text-muted-foreground">
          {multiline ? 'Strg/Cmd + Enter oder Esc übernimmt' : 'Enter oder Esc übernimmt'}
        </p>
      </PopoverContent>
    </Popover>
  );
}

function TextCell(props: PropertyCellProps) {
  // URL, E-Mail and phone numbers are single-line by nature; only TEXT gets a
  // textarea, so a newline never sneaks into a mailto: link.
  const isFreeText = props.property.type === 'TEXT';
  return (
    <ExpandableTextCell
      {...props}
      multiline={isFreeText}
      inputType={
        props.property.type === 'EMAIL' ? 'email' : props.property.type === 'URL' ? 'url' : 'text'
      }
      format={(value) => (typeof value === 'string' ? value : '')}
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

/**
 * Two input conventions, kept strictly apart because mixing them is how a
 * calendar ends up off by a timezone:
 *
 * - **Whole days** (`includeTime: false`, or an all-day span) use
 *   `<input type="date">` and are stored as UTC midnight. Reading is a plain
 *   `slice(0, 10)` of the ISO string, which is the convention every DATE value
 *   in this codebase already followed.
 * - **Times** (`includeTime: true`) use `<input type="datetime-local">`, which
 *   speaks the viewer's wall clock. `new Date(localString)` parses it as local
 *   and `toISOString()` hands back the UTC instant, so the round-trip is exact.
 */
function isoDateOnly(iso: string | null): string {
  return iso === null ? '' : iso.slice(0, 10);
}

function isoToDateTimeLocal(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function inputToIso(raw: string, includeTime: boolean): string | null {
  if (raw.length === 0) return null;
  const date = includeTime ? new Date(raw) : new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Reads either DATE response shape into one internal form. */
interface DateCellValue {
  start: string | null;
  end: string | null;
  allDay: boolean;
}

function readDateValue(value: CellValue): DateCellValue {
  if (typeof value === 'string') return { start: value, end: null, allDay: false };
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'start' in value) {
    return { start: value.start, end: value.end, allDay: value.allDay };
  }
  return { start: null, end: null, allDay: false };
}

/**
 * German rendering of a DATE value in either shape. A span on one day shows the
 * day once and both times, which is how an appointment is normally read; a span
 * across days shows both sides in full. Returns null for an empty value so a
 * caller can drop the element entirely.
 */
export function formatDateValue(property: DatabaseProperty, value: CellValue): string | null {
  const config = parseDatePropertyConfig(property.config);
  const { start, end, allDay } = readDateValue(value);
  if (start === null) return null;

  const withTime = config.includeTime && !allDay;
  const day = (iso: string) => new Date(iso).toLocaleDateString('de-DE');
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const full = (iso: string) => (withTime ? `${day(iso)}, ${time(iso)}` : day(iso));

  if (end === null) return full(start);
  if (day(start) === day(end)) {
    return withTime ? `${day(start)}, ${time(start)} bis ${time(end)}` : day(start);
  }
  return `${full(start)} bis ${full(end)}`;
}

function DateCell({ property, value, onChange, readOnly }: PropertyCellProps) {
  const config = parseDatePropertyConfig(property.config);
  const current = readDateValue(value);
  const includeTime = config.includeTime && !current.allDay;
  const inputType = includeTime ? 'datetime-local' : 'date';
  const toInput = includeTime ? isoToDateTimeLocal : isoDateOnly;
  const inputClass =
    'h-8 border-transparent bg-transparent px-1.5 shadow-none hover:border-input focus-visible:ring-1';

  // A non-span property keeps writing the bare ISO string the API expects for
  // it; only a span property may send the object form.
  const emit = (next: DateCellValue) => {
    if (!config.isRange) {
      onChange(next.start);
      return;
    }
    if (next.start === null) {
      onChange(null);
      return;
    }
    onChange({ start: next.start, end: next.end, allDay: next.allDay });
  };

  if (!config.isRange) {
    return (
      <Input
        type={inputType}
        defaultValue={toInput(current.start)}
        readOnly={readOnly}
        className={inputClass}
        onChange={(event) => {
          emit({ ...current, start: inputToIso(event.target.value, includeTime) });
        }}
      />
    );
  }

  return (
    <div className="flex min-h-8 flex-col gap-0.5">
      <Input
        type={inputType}
        aria-label="Beginn"
        defaultValue={toInput(current.start)}
        readOnly={readOnly}
        className={inputClass}
        onChange={(event) => {
          const start = inputToIso(event.target.value, includeTime);
          // Clearing the start clears the whole span: an end without a
          // beginning is not a value the API accepts.
          emit(
            start === null
              ? { start: null, end: null, allDay: current.allDay }
              : { ...current, start },
          );
        }}
      />
      <Input
        type={inputType}
        aria-label="Ende"
        defaultValue={toInput(current.end)}
        readOnly={readOnly}
        className={inputClass}
        onChange={(event) => {
          emit({ ...current, end: inputToIso(event.target.value, includeTime) });
        }}
      />
    </div>
  );
}

function OptionBadge({ optionId, property }: { optionId: string; property: DatabaseProperty }) {
  const option = property.options.find((entry) => entry.id === optionId);
  if (option === undefined) return null;
  return (
    <Badge
      variant="outline"
      className={cn(
        'border-transparent',
        OPTION_COLOR_BG_CLASS[option.color],
        OPTION_COLOR_TEXT_CLASS[option.color],
      )}
    >
      {option.label}
    </Badge>
  );
}

function SelectCell({ property, value, onChange, readOnly }: PropertyCellProps) {
  const [open, setOpen] = React.useState(false);
  const selected = typeof value === 'string' ? value : null;

  if (readOnly) {
    return (
      <div className="flex min-h-8 items-center px-1.5">
        {selected !== null ? <OptionBadge optionId={selected} property={property} /> : null}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex min-h-8 w-full items-center gap-1 rounded-md px-1.5 text-left hover:bg-accent"
          >
            {selected !== null ? (
              <OptionBadge optionId={selected} property={property} />
            ) : (
              <span className="text-sm text-muted-foreground">Leer</span>
            )}
          </button>
        }
      />
      <PopoverContent align="start" className="w-56 p-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
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
            className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              onChange(option.id);
              setOpen(false);
            }}
          >
            <Badge
              variant="outline"
              className={cn(
                'border-transparent',
                OPTION_COLOR_BG_CLASS[option.color],
                OPTION_COLOR_TEXT_CLASS[option.color],
              )}
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

function MultiSelectCell({
  property,
  value,
  onChange,
  readOnly,
  rowHeight = 'short',
}: PropertyCellProps) {
  const [open, setOpen] = React.useState(false);
  const selected = Array.isArray(value) ? value : [];

  const toggle = (optionId: string) => {
    onChange(
      selected.includes(optionId)
        ? selected.filter((entry) => entry !== optionId)
        : [...selected, optionId],
    );
  };

  // Badges wrap as boxes, not as lines, so the row height caps them by height
  // instead of by `line-clamp`. Whatever does not fit stays reachable in the
  // option list this cell opens.
  const badges = (
    <div className={cn('flex flex-wrap gap-1 overflow-hidden', ROW_HEIGHT_BOX_CLAMP[rowHeight])}>
      {selected.map((optionId) => (
        <OptionBadge key={optionId} optionId={optionId} property={property} />
      ))}
    </div>
  );

  if (readOnly) {
    return <div className="flex min-h-8 items-center px-1.5 py-1">{badges}</div>;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex min-h-8 w-full items-center rounded-md px-1.5 py-1 text-left hover:bg-accent"
          >
            {selected.length > 0 ? (
              badges
            ) : (
              <span className="text-sm text-muted-foreground">Leer</span>
            )}
          </button>
        }
      />
      <PopoverContent align="start" className="w-56 p-1">
        {property.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
            onClick={() => toggle(option.id)}
          >
            <Badge
              variant="outline"
              className={cn(
                'border-transparent',
                OPTION_COLOR_BG_CLASS[option.color],
                OPTION_COLOR_TEXT_CLASS[option.color],
              )}
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
function IdListCell(props: PropertyCellProps) {
  return (
    <ExpandableTextCell
      {...props}
      multiline={false}
      monospace
      placeholder="IDs, durch Komma getrennt"
      format={(value) => (Array.isArray(value) ? value.join(', ') : '')}
      parse={(raw) => {
        const next = raw
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        return next.length === 0 ? null : next;
      }}
    />
  );
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T/;

function formatComputed(property: DatabaseProperty, value: CellValue): string {
  if (value === null) return '–';
  if (property.type === 'CREATED_TIME' || property.type === 'UPDATED_TIME') {
    return formatInstant(String(value));
  }
  // A formula answers a number, a text, a date or a yes/no, and the cell only
  // ever sees the value. An ISO instant is recognised by its shape so a date
  // formula reads like a date column rather than like a timestamp.
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  if (typeof value === 'string' && ISO_INSTANT.test(value)) return formatInstant(value);
  if (typeof value === 'number') return value.toLocaleString('de-DE', { maximumFractionDigits: 6 });
  return String(value);
}

function formatInstant(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

function ReadonlyCell({
  property,
  value,
  rowHeight = 'short',
}: {
  property: DatabaseProperty;
  value: CellValue;
  rowHeight?: DatabaseRowHeight;
}) {
  const text = formatComputed(property, value);
  return (
    <div
      className="flex min-h-8 items-start px-1.5 py-1.5 text-sm text-muted-foreground"
      data-testid="readonly-cell"
    >
      <span
        title={text}
        className={cn('break-words whitespace-normal', ROW_HEIGHT_LINE_CLAMP[rowHeight])}
      >
        {text}
      </span>
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
