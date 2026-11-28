import {
  DATABASE_TITLE_COLUMN_KEY,
  type DatabaseProperty,
  type DatabaseSort,
} from '@exocortex/contracts';

/**
 * The list operations behind a view's order (issue #296).
 *
 * A view's `sorts` is a priority list: the first rule decides, every later one
 * only breaks the ties left by the ones above it. Each column appears at most
 * once, because a second rule for the same column could never decide
 * anything. Every function here returns a new list and never touches the one
 * it was given, since the list it reads is the query cache.
 */

export type SortDirection = DatabaseSort['direction'];

/** A column a view can be sorted by: the row's name, or one of its properties. */
export interface SortableColumn {
  key: string;
  name: string;
}

export function sortableColumns(
  titleName: string,
  properties: readonly DatabaseProperty[],
): SortableColumn[] {
  return [
    { key: DATABASE_TITLE_COLUMN_KEY, name: titleName },
    ...properties.map((property) => ({ key: property.id, name: property.name })),
  ];
}

/** Where a column stands in the order, or null when nothing sorts by it. */
export function sortOf(
  sorts: readonly DatabaseSort[],
  key: string,
): { index: number; direction: SortDirection } | null {
  const index = sorts.findIndex((sort) => sort.propertyId === key);
  const sort = sorts[index];
  return sort === undefined ? null : { index, direction: sort.direction };
}

/**
 * Sorting by a column from its header. A rule that already exists changes
 * direction and keeps its priority; a new one goes last, so sorting by the
 * date and then by the name, in that order, gives "by date, then by name".
 */
export function sortByColumn(
  sorts: readonly DatabaseSort[],
  key: string,
  direction: SortDirection,
): DatabaseSort[] {
  if (sorts.some((sort) => sort.propertyId === key)) {
    return sorts.map((sort) => (sort.propertyId === key ? { ...sort, direction } : sort));
  }
  return [...sorts, { propertyId: key, direction }];
}

export function withoutColumn(sorts: readonly DatabaseSort[], key: string): DatabaseSort[] {
  return sorts.filter((sort) => sort.propertyId !== key);
}

export function withDirection(
  sorts: readonly DatabaseSort[],
  index: number,
  direction: SortDirection,
): DatabaseSort[] {
  return sorts.map((sort, at) => (at === index ? { ...sort, direction } : sort));
}

/**
 * Points a rule at another column, in place. A rule elsewhere in the list
 * that already sorted by that column is dropped, so the column is not sorted
 * twice and the rule the person is editing is the one that survives.
 */
export function withColumn(
  sorts: readonly DatabaseSort[],
  index: number,
  key: string,
): DatabaseSort[] {
  return sorts.flatMap((sort, at) => {
    if (at === index) return [{ ...sort, propertyId: key }];
    return sort.propertyId === key ? [] : [sort];
  });
}

/** Moves the rule at `from` so that it ends up at `to`; out-of-range moves change nothing. */
export function moveSort(sorts: readonly DatabaseSort[], from: number, to: number): DatabaseSort[] {
  if (from === to || from < 0 || to < 0 || from >= sorts.length || to >= sorts.length) {
    return [...sorts];
  }
  const next = [...sorts];
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(to, 0, moved);
  return next;
}

/** The first column nothing sorts by yet, which a new rule starts on. */
export function nextUnsortedColumn(
  columns: readonly SortableColumn[],
  sorts: readonly DatabaseSort[],
): SortableColumn | null {
  const used = new Set(sorts.map((sort) => sort.propertyId));
  return columns.find((column) => !used.has(column.key)) ?? null;
}

/**
 * Which slot a dragged rule lands in, from where the pointer is. `midpoints`
 * are the vertical centres of the rows as they stood when the drag began;
 * the dragged row's own centre is skipped, so the answer is the number of
 * other rows the pointer has passed.
 */
export function dropIndex(midpoints: readonly number[], from: number, pointerY: number): number {
  let index = 0;
  midpoints.forEach((midpoint, at) => {
    if (at !== from && pointerY > midpoint) index += 1;
  });
  return index;
}
