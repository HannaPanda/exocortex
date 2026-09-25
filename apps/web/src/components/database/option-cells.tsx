'use client';

import { CheckIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabaseProperty, type DatabasePropertyOption } from '@exocortex/contracts';
import { Badge, cn, Popover, PopoverContent, PopoverTrigger } from '@exocortex/ui';

import { type PropertyCellProps } from './cells';
import { OPTION_COLOR_BG_CLASS, OPTION_COLOR_TEXT_CLASS } from './property-types';
import { ROW_HEIGHT_BOX_CLAMP } from './table-columns';

/**
 * SELECT and MULTI_SELECT: a value that is one or several option ids, shown as
 * coloured badges. Split out of `cells.tsx` (issue #97).
 */

/** One option in its colour. */
function OptionColorBadge({ option }: { option: DatabasePropertyOption }) {
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

/** The option a stored id names; nothing when the option was deleted since. */
export function OptionBadge({
  optionId,
  property,
}: {
  optionId: string;
  property: DatabaseProperty;
}) {
  const option = property.options.find((entry) => entry.id === optionId);
  if (option === undefined) return null;
  return <OptionColorBadge option={option} />;
}

export function SelectCell({ property, value, onChange, readOnly }: PropertyCellProps) {
  const t = useTranslations('database.cells');
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
              <span className="text-sm text-muted-foreground">{t('empty')}</span>
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
          <XIcon className="size-3.5 text-muted-foreground" /> {t('noSelection')}
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
            <OptionColorBadge option={option} />
            {option.id === selected ? <CheckIcon className="size-3.5" /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function MultiSelectCell({
  property,
  value,
  onChange,
  readOnly,
  rowHeight = 'short',
}: PropertyCellProps) {
  const t = useTranslations('database.cells');
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
              <span className="text-sm text-muted-foreground">{t('empty')}</span>
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
            <OptionColorBadge option={option} />
            {selected.includes(option.id) ? <CheckIcon className="size-3.5" /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
