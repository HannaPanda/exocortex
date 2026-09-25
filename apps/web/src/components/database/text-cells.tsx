'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { cn, Input, Popover, PopoverContent, PopoverTrigger, Textarea } from '@exocortex/ui';

import { type CellValue, type PropertyCellProps } from './cells';
import { ROW_HEIGHT_LINE_CLAMP } from './table-columns';

/**
 * The cells whose value is typed as text: free text, URL, e-mail, phone, the
 * id lists of PERSON and FILES, and numbers. Split out of `cells.tsx`
 * (issue #97); they share the commit-on-close contract and the cell box.
 */

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
  'rounded-md hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none';

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
  placeholder,
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
  // `DocumentTitleInput` in document-title-input.tsx).
  const t = useTranslations('database.cells');
  const shownPlaceholder = placeholder ?? t('empty');
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
      <span className="text-muted-foreground">{shownPlaceholder}</span>
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
            placeholder={shownPlaceholder}
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
            placeholder={shownPlaceholder}
            className={cn('text-sm', monospace && 'font-mono text-xs')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setOpen(false);
            }}
          />
        )}
        <p className="px-1 pt-1 text-micro text-muted-foreground">
          {multiline ? t('commitHintMultiline') : t('commitHint')}
        </p>
      </PopoverContent>
    </Popover>
  );
}

export function TextCell(props: PropertyCellProps) {
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

export function NumberCell({ value, onChange, readOnly }: PropertyCellProps) {
  const t = useTranslations('database.cells');
  const [draft, setDraft] = React.useState(typeof value === 'number' ? String(value) : '');

  return (
    <Input
      type="number"
      value={draft}
      readOnly={readOnly}
      placeholder={t('empty')}
      className="h-8 border-transparent bg-transparent px-1.5 text-right shadow-none hover:border-input"
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

/**
 * PERSON and FILES store an array of ids (user ids / attachment ids). A
 * proper member picker or file browser is a separate feature; this is the
 * honest minimal editor for the array itself, entered as a comma-separated
 * list, so the property round-trips completely through the API.
 */
export function IdListCell(props: PropertyCellProps) {
  const t = useTranslations('database.cells');
  return (
    <ExpandableTextCell
      {...props}
      multiline={false}
      monospace
      placeholder={t('idListPlaceholder')}
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
