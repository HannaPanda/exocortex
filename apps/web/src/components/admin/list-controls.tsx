'use client';

import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TableHead,
} from '@exocortex/ui';

/**
 * The parts every growing admin list shares (issue #176): its state in the
 * URL, a search field, a sortable column head and a pager.
 *
 * The state lives in the address rather than in component state so a filtered
 * view survives a reload and can be linked, and so the back button undoes a
 * filter. A parameter that equals its default is left out of the address,
 * which keeps the plain page at its plain URL.
 */

export type ListParams = Record<string, string>;

export function useListParams<T extends ListParams>(
  defaults: T,
): [T, (patch: Partial<T>, options?: { keepPage?: boolean }) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const current = React.useMemo(() => {
    const values: ListParams = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const value = searchParams.get(key);
      if (value !== null && value !== '') values[key] = value;
    }
    return values as T;
  }, [defaults, searchParams]);

  const update = React.useCallback(
    (patch: Partial<T>, options?: { keepPage?: boolean }) => {
      const next = new URLSearchParams(searchParams.toString());
      const merged: ListParams = { ...current, ...patch };
      // Any change to what is listed starts again on the first page; otherwise
      // a search typed on page five can answer "nothing here" for a list that
      // has matches.
      if (options?.keepPage !== true && 'page' in defaults) merged.page = defaults.page ?? '1';
      for (const [key, value] of Object.entries(merged)) {
        if (value === defaults[key] || value === '') next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
    },
    [current, defaults, pathname, router, searchParams],
  );

  return [current, update];
}

/** A search field that commits a quarter second after the last keystroke. */
export function ListSearch({
  value,
  onCommit,
  label,
  placeholder,
  testId,
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  placeholder: string;
  testId?: string;
}) {
  const [draft, setDraft] = React.useState(value);
  const lastCommitted = React.useRef(value);

  // The address can change under the field (back button, a reset); follow it.
  React.useEffect(() => {
    if (value !== lastCommitted.current) {
      lastCommitted.current = value;
      setDraft(value);
    }
  }, [value]);

  React.useEffect(() => {
    if (draft === lastCommitted.current) return;
    const timer = window.setTimeout(() => {
      lastCommitted.current = draft;
      onCommit(draft);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft, onCommit]);

  return (
    <Input
      type="search"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder}
      aria-label={label}
      className="sm:max-w-xs"
      data-testid={testId}
    />
  );
}

/** A labelled filter: the label stays visible, so nobody has to guess what "Alle" filters. */
export function ListFilter({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  testId?: string;
}) {
  const id = React.useId();
  const selected = options.find((option) => option.value === value)?.label ?? value;
  return (
    <div className="flex items-center gap-2">
      <span id={id} className="text-sm text-muted-foreground">
        {label}
      </span>
      <Select value={value} onValueChange={(next) => onChange(String(next))}>
        <SelectTrigger aria-labelledby={id} size="sm" data-testid={testId}>
          {/* Base UI shows the raw value without this. */}
          <SelectValue>{() => selected}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * A column head that sorts. The button carries the action, the `th` carries
 * `aria-sort`, which is where a screen reader looks for the current order.
 */
export function SortableHead<S extends string>({
  column,
  sort,
  order,
  onSort,
  children,
  defaultOrder = 'asc',
}: {
  column: S;
  sort: string;
  order: string;
  onSort: (sort: S, order: 'asc' | 'desc') => void;
  children: React.ReactNode;
  /** Which way a first click sorts: dates usually want the newest first. */
  defaultOrder?: 'asc' | 'desc';
}) {
  const t = useTranslations('admin.list');
  const active = sort === column;
  const nextOrder = active ? (order === 'asc' ? 'desc' : 'asc') : defaultOrder;
  const Icon = !active ? ArrowUpDown : order === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead
      aria-sort={active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}
      className="whitespace-nowrap"
    >
      <button
        type="button"
        onClick={() => onSort(column, nextOrder)}
        className="-mx-1 inline-flex items-center gap-1 rounded-sm px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        title={t(nextOrder === 'asc' ? 'sortAscending' : 'sortDescending')}
      >
        {children}
        <Icon aria-hidden className={active ? 'size-3.5' : 'size-3.5 text-muted-foreground/60'} />
      </button>
    </TableHead>
  );
}

/** "51–100 of 644", and the two buttons beside it. Hidden while one page holds everything. */
export function ListPager({
  page,
  pageSize,
  total,
  onPage,
  testId,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  testId?: string;
}) {
  const t = useTranslations('admin.list');
  const format = useFormatter();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"
      data-testid={testId}
    >
      <span aria-live="polite">
        {t('range', {
          from: format.number(from),
          to: format.number(to),
          total,
        })}
      </span>
      {pages > 1 ? (
        <nav aria-label={t('pagerLabel')} className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            {t('previous')}
          </Button>
          <span>{t('pageOf', { page, pages })}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => onPage(page + 1)}
          >
            {t('next')}
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

/** Reads a positive page number from the address, falling back to the first page. */
export function pageFrom(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}
