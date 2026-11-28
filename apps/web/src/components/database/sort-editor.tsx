'use client';

import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  GripVerticalIcon,
  PlusIcon,
  XIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DatabaseSort } from '@exocortex/contracts';
import {
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import {
  dropIndex,
  moveSort,
  nextUnsortedColumn,
  type SortableColumn,
  type SortDirection,
  withColumn,
  withDirection,
} from './sort-rules';

interface SortEditorProps {
  sorts: readonly DatabaseSort[];
  columns: readonly SortableColumn[];
  readOnly: boolean;
  onChange: (sorts: DatabaseSort[]) => void;
}

function columnName(columns: readonly SortableColumn[], key: string): string {
  return columns.find((column) => column.key === key)?.name ?? '?';
}

function DirectionIcon({ direction }: { direction: SortDirection }) {
  return direction === 'asc' ? (
    <ArrowUpIcon className="size-3" aria-hidden />
  ) : (
    <ArrowDownIcon className="size-3" aria-hidden />
  );
}

/**
 * A view's order in the sort bar, and the one place that edits all of it
 * (issue #296).
 *
 * The trigger shows the rules in their priority order, so what decides the
 * table is readable without opening anything. Inside, each rule has a column,
 * a direction and a remove button, and its priority is its place in the list:
 * dragged by the grip (pointer events, so a finger works like a mouse) or
 * moved with Alt+↑/↓ on the grip, which is also what a screen reader is told.
 */
export function SortEditor({ sorts, columns, readOnly, onChange }: SortEditorProps) {
  const t = useTranslations('database.sorts');
  const ruleLabels = sorts.map((sort) =>
    t('ruleLabel', { name: columnName(columns, sort.propertyId), direction: sort.direction }),
  );

  const chips = sorts.map((sort, index) => (
    <span
      key={sort.propertyId}
      className="inline-flex min-w-0 items-center gap-1 rounded-sm bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground"
    >
      {sorts.length > 1 ? (
        <span className="exocortex-numeric text-muted-foreground">{index + 1}</span>
      ) : null}
      <DirectionIcon direction={sort.direction} />
      <span className="max-w-32 truncate">{columnName(columns, sort.propertyId)}</span>
    </span>
  ));

  if (readOnly) {
    if (sorts.length === 0) return null;
    return (
      <span className="inline-flex flex-wrap items-center gap-1" data-testid="sort-summary">
        <span className="sr-only">{t('summary', { rules: ruleLabels.join(', ') })}</span>
        <ArrowUpDownIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="inline-flex flex-wrap items-center gap-1" aria-hidden>
          {chips}
        </span>
      </span>
    );
  }

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="h-auto min-h-8 max-w-full flex-wrap justify-start py-1"
            data-testid="add-sort"
            aria-label={
              sorts.length === 0 ? undefined : t('editLabel', { rules: ruleLabels.join(', ') })
            }
          >
            <ArrowUpDownIcon />
            {sorts.length === 0 ? t('trigger') : chips}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-2">
        <SortRuleList sorts={sorts} columns={columns} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}

interface DragState {
  from: number;
  over: number;
  midpoints: number[];
  pointerId: number;
  startY: number;
  pointerY: number;
  /** How far a neighbour slides to make room: the dragged row's height plus the gap. */
  step: number;
}

/** The gap between two rules, in pixels: `gap-1`. */
const RULE_GAP = 4;

/**
 * Where a row is drawn while another one is dragged. The list keeps its DOM
 * order until the drop: moving the dragged node would end its pointer capture
 * and the drag with it. So the dragged row follows the pointer and the rows it
 * has passed slide one step the other way, which is the order the drop will
 * store.
 */
function dragOffset(drag: DragState, index: number): number {
  if (index === drag.from) return drag.pointerY - drag.startY;
  if (drag.from < drag.over && index > drag.from && index <= drag.over) return -drag.step;
  if (drag.from > drag.over && index >= drag.over && index < drag.from) return drag.step;
  return 0;
}

function SortRuleList({
  sorts,
  columns,
  onChange,
}: {
  sorts: readonly DatabaseSort[];
  columns: readonly SortableColumn[];
  onChange: (sorts: DatabaseSort[]) => void;
}) {
  const t = useTranslations('database.sorts');
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  const rowRefs = React.useRef(new Map<string, HTMLLIElement>());
  const gripRefs = React.useRef(new Map<string, HTMLButtonElement>());
  // The rule whose grip should hold the focus after the list re-renders: a
  // moved row is a moved DOM node, and a browser drops the focus of a node it
  // takes out of the document, even for the instant of putting it back.
  const refocus = React.useRef<string | null>(null);

  const nextColumn = nextUnsortedColumn(columns, sorts);

  React.useLayoutEffect(() => {
    const key = refocus.current;
    if (key === null) return;
    refocus.current = null;
    const grip = gripRefs.current.get(key);
    if (grip !== undefined && document.activeElement !== grip) grip.focus();
  });

  const announceMove = (key: string, position: number) => {
    setAnnouncement(
      t('moved', { name: columnName(columns, key), position: position + 1, count: sorts.length }),
    );
  };

  const move = (from: number, to: number) => {
    const sort = sorts[from];
    if (sort === undefined || to < 0 || to >= sorts.length || to === from) return;
    refocus.current = sort.propertyId;
    onChange(moveSort(sorts, from, to));
    announceMove(sort.propertyId, to);
  };

  const startDrag = (event: React.PointerEvent<HTMLButtonElement>, index: number) => {
    if (event.button !== 0) return;
    const rects = sorts.map((sort) =>
      rowRefs.current.get(sort.propertyId)?.getBoundingClientRect(),
    );
    const midpoints = rects.map((rect) => (rect === undefined ? 0 : rect.top + rect.height / 2));
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      from: index,
      over: index,
      midpoints,
      pointerId: event.pointerId,
      startY: event.clientY,
      pointerY: event.clientY,
      step: (rects[index]?.height ?? 0) + RULE_GAP,
    });
  };

  const continueDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    setDrag({
      ...drag,
      pointerY: event.clientY,
      over: dropIndex(drag.midpoints, drag.from, event.clientY),
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>, commit: boolean) => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    setDrag(null);
    if (commit && drag.over !== drag.from) move(drag.from, drag.over);
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="px-1 text-xs font-medium text-muted-foreground">{t('heading')}</p>
      {sorts.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ol
          className={cn('flex flex-col gap-1', drag === null ? null : 'select-none')}
          data-testid="sort-rules"
        >
          {sorts.map((sort, at) => {
            const name = columnName(columns, sort.propertyId);
            const dragging = drag?.from === at;
            const offset = drag === null ? 0 : dragOffset(drag, at);
            const used = new Set(
              sorts
                .filter((other) => other.propertyId !== sort.propertyId)
                .map((o) => o.propertyId),
            );
            return (
              <li
                key={sort.propertyId}
                ref={(node) => {
                  if (node === null) rowRefs.current.delete(sort.propertyId);
                  else rowRefs.current.set(sort.propertyId, node);
                }}
                className={cn(
                  'flex items-center gap-1 rounded-md px-0.5 py-0.5',
                  // The dragged row moves with the pointer, without a lag.
                  dragging
                    ? 'relative z-10 bg-accent transition-none'
                    : 'transition-transform motion-reduce:transition-none',
                )}
                style={offset === 0 ? undefined : { transform: `translateY(${offset}px)` }}
                data-testid={`sort-rule-${at}`}
              >
                <button
                  type="button"
                  ref={(node) => {
                    if (node === null) gripRefs.current.delete(sort.propertyId);
                    else gripRefs.current.set(sort.propertyId, node);
                  }}
                  aria-label={t('move', { name })}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  className={cn(
                    'flex size-7 shrink-0 touch-none items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    dragging ? 'cursor-grabbing' : 'cursor-grab',
                  )}
                  data-testid={`sort-grip-${at}`}
                  onPointerDown={(event) => startDrag(event, at)}
                  onPointerMove={continueDrag}
                  onPointerUp={(event) => endDrag(event, true)}
                  onPointerCancel={(event) => endDrag(event, false)}
                  onKeyDown={(event) => {
                    if (drag !== null && event.key === 'Escape') {
                      // Cancels the drag, not the popover around it.
                      event.preventDefault();
                      event.stopPropagation();
                      setDrag(null);
                      return;
                    }
                    if (!event.altKey) return;
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      move(at, at - 1);
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      move(at, at + 1);
                    }
                  }}
                >
                  <GripVerticalIcon className="size-4" aria-hidden />
                </button>
                <span
                  className="exocortex-numeric w-4 shrink-0 text-center text-xs text-muted-foreground"
                  aria-hidden
                >
                  {at + 1}
                </span>
                <Select
                  value={sort.propertyId}
                  onValueChange={(next) => {
                    if (next === null || next === sort.propertyId) return;
                    onChange(withColumn(sorts, at, next));
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="min-w-0 flex-1"
                    aria-label={t('column')}
                    data-testid={`sort-column-${at}`}
                  >
                    <SelectValue>{() => name}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {columns
                      .filter((column) => !used.has(column.key))
                      .map((column) => (
                        <SelectItem key={column.key} value={column.key}>
                          {column.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Select
                  value={sort.direction}
                  onValueChange={(next) => {
                    if (next !== 'asc' && next !== 'desc') return;
                    onChange(withDirection(sorts, at, next));
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-36 shrink-0"
                    aria-label={t('direction')}
                    data-testid={`sort-direction-${at}`}
                  >
                    <SelectValue>
                      {() => (sort.direction === 'asc' ? t('ascending') : t('descending'))}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="asc">{t('ascending')}</SelectItem>
                    <SelectItem value="desc">{t('descending')}</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('remove', { name })}
                  data-testid={`sort-remove-${at}`}
                  onClick={() => onChange(sorts.filter((_, entry) => entry !== at))}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap items-center justify-between gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={nextColumn === null}
          data-testid="sort-add-rule"
          onClick={() => {
            if (nextColumn === null) return;
            onChange([...sorts, { propertyId: nextColumn.key, direction: 'asc' }]);
          }}
        >
          <PlusIcon /> {t('add')}
        </Button>
        {sorts.length > 1 ? (
          <Button variant="ghost" size="sm" data-testid="sort-clear" onClick={() => onChange([])}>
            {t('clear')}
          </Button>
        ) : null}
      </div>
      {sorts.length > 1 ? <p className="px-1 text-xs text-muted-foreground">{t('hint')}</p> : null}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
