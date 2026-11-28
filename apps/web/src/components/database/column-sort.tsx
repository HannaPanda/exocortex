'use client';

import { ArrowDownIcon, ArrowUpIcon, MoreVerticalIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { type DatabaseSort } from '@exocortex/contracts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@exocortex/ui';

import { sortByColumn, sortOf, withoutColumn } from './sort-rules';

/**
 * What a table's column header says and offers about the view's order
 * (issue #296). Sorting from a header goes through `sortByColumn`: a rule the
 * column already has turns around in place, a new one goes last.
 */
export interface ColumnSortControls {
  sorts: readonly DatabaseSort[];
  onChange: (sorts: DatabaseSort[]) => void;
}

/** The arrow beside a sorted column's name, with its place when there is more than one rule. */
export function ColumnSortIndicator({
  sorts,
  columnKey,
}: {
  sorts: readonly DatabaseSort[];
  columnKey: string;
}) {
  const t = useTranslations('database.sorts');
  const sort = sortOf(sorts, columnKey);
  if (sort === null) return null;
  const Icon = sort.direction === 'asc' ? ArrowUpIcon : ArrowDownIcon;
  return (
    <span
      className="inline-flex shrink-0 items-center text-muted-foreground"
      role="img"
      aria-label={t('indicator', {
        direction: sort.direction,
        position: sort.index + 1,
        count: sorts.length,
      })}
      data-testid={`column-sort-${columnKey}`}
      data-direction={sort.direction}
    >
      <Icon className="size-3" aria-hidden />
      {sorts.length > 1 ? (
        <span className="exocortex-numeric text-xs leading-none" aria-hidden>
          {sort.index + 1}
        </span>
      ) : null}
    </span>
  );
}

/** The three sort entries of a column menu. */
export function ColumnSortItems({
  controls,
  columnKey,
}: {
  controls: ColumnSortControls;
  columnKey: string;
}) {
  const t = useTranslations('database.sorts');
  const sort = sortOf(controls.sorts, columnKey);
  return (
    <>
      <DropdownMenuItem
        disabled={sort?.direction === 'asc'}
        onClick={() => controls.onChange(sortByColumn(controls.sorts, columnKey, 'asc'))}
        data-testid={`column-sort-asc-${columnKey}`}
      >
        <ArrowUpIcon /> {t('sortAscending')}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={sort?.direction === 'desc'}
        onClick={() => controls.onChange(sortByColumn(controls.sorts, columnKey, 'desc'))}
        data-testid={`column-sort-desc-${columnKey}`}
      >
        <ArrowDownIcon /> {t('sortDescending')}
      </DropdownMenuItem>
      {sort === null ? null : (
        <DropdownMenuItem
          onClick={() => controls.onChange(withoutColumn(controls.sorts, columnKey))}
          data-testid={`column-sort-remove-${columnKey}`}
        >
          <XIcon /> {t('removeColumnSort')}
        </DropdownMenuItem>
      )}
    </>
  );
}

/**
 * The name column's header. It has no property behind it, so nothing to
 * rename, configure or delete; sorting by the row's name is all its menu
 * offers. Read-only, it is the plain label with the indicator beside it.
 */
export function TitleColumnHeader({
  label,
  columnKey,
  controls,
  readOnly,
}: {
  label: string;
  columnKey: string;
  controls: ColumnSortControls;
  readOnly: boolean;
}) {
  if (readOnly) {
    return (
      <span className="flex min-w-0 flex-1 items-center gap-1">
        <span className="truncate">{label}</span>
        <ColumnSortIndicator sorts={controls.sorts} columnKey={columnKey} />
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center justify-between gap-1 rounded-sm px-1 py-0.5 hover:bg-accent"
            data-testid="title-column-menu"
          >
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate">{label}</span>
              <ColumnSortIndicator sorts={controls.sorts} columnKey={columnKey} />
            </span>
            <MoreVerticalIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        }
      />
      <DropdownMenuContent align="start">
        <ColumnSortItems controls={controls} columnKey={columnKey} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
