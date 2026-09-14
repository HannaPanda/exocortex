import {
  DATABASE_COLUMN_DEFAULT_WIDTH,
  DATABASE_COLUMN_MAX_WIDTH,
  DATABASE_COLUMN_MIN_WIDTH,
  DATABASE_TITLE_COLUMN_KEY,
  type DatabaseProperty,
  type DatabaseRowHeight,
  type DatabaseView,
  type DatabaseViewConfig,
} from '@exocortex/contracts';

/**
 * Column layout of a table view: which properties are shown, in which order,
 * and how wide. All three live in `view.config`, so the same database can be a
 * dense overview in one view and a wide working table in another.
 */

/** Tailwind clamp for the number of lines a row height shows. */
export const ROW_HEIGHT_LINE_CLAMP: Record<DatabaseRowHeight, string> = {
  short: 'line-clamp-1',
  medium: 'line-clamp-3',
  tall: 'line-clamp-6',
};

/**
 * Same limit for content that wraps as boxes instead of lines (badge lists):
 * `line-clamp` counts line boxes, which a wrapping flex row does not produce.
 */
export const ROW_HEIGHT_BOX_CLAMP: Record<DatabaseRowHeight, string> = {
  short: 'max-h-8',
  medium: 'max-h-20',
  tall: 'max-h-36',
};

export const ROW_HEIGHT_LABELS: Record<DatabaseRowHeight, string> = {
  short: 'Kompakt',
  medium: 'Mittel',
  tall: 'Hoch',
};

export const ROW_HEIGHTS: DatabaseRowHeight[] = ['short', 'medium', 'tall'];

export function rowHeightOf(view: DatabaseView): DatabaseRowHeight {
  return view.config.rowHeight ?? 'short';
}

export function columnWidthOf(view: DatabaseView, key: string): number {
  return view.config.columnWidths?.[key] ?? DATABASE_COLUMN_DEFAULT_WIDTH;
}

export function clampColumnWidth(width: number): number {
  return Math.min(
    DATABASE_COLUMN_MAX_WIDTH,
    Math.max(DATABASE_COLUMN_MIN_WIDTH, Math.round(width)),
  );
}

/**
 * Properties shown in the table, in view order.
 *
 * A property missing from `config.visibleProperties` is visible: that is what
 * makes a freshly created property appear without the view having to be
 * touched, and it keeps every view created before this config existed working.
 */
export function visibleTableProperties(
  view: DatabaseView,
  properties: DatabaseProperty[],
): DatabaseProperty[] {
  const entries = view.config.visibleProperties;
  if (entries.length === 0) return properties;

  const byId = new Map(entries.map((entry) => [entry.propertyId, entry]));
  const configured = properties
    .filter((property) => byId.get(property.id)?.visible !== false)
    .filter((property) => byId.has(property.id))
    .sort((left, right) => {
      const leftKey = byId.get(left.id)?.orderKey ?? '';
      const rightKey = byId.get(right.id)?.orderKey ?? '';
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const unconfigured = properties.filter((property) => !byId.has(property.id));
  return [...configured, ...unconfigured];
}

/**
 * Writes the complete visibility list in display order. Always writing every
 * property (instead of only the toggled one) keeps the order keys dense and
 * makes the list the single description of the column layout.
 */
export function toggleColumnVisibility(
  view: DatabaseView,
  properties: DatabaseProperty[],
  propertyId: string,
): DatabaseViewConfig['visibleProperties'] {
  const ordered = visibleTableProperties(view, properties);
  const visibleIds = new Set(ordered.map((property) => property.id));
  const displayOrder = [
    ...ordered,
    ...properties.filter((property) => !visibleIds.has(property.id)),
  ];

  return displayOrder.map((property, index) => ({
    propertyId: property.id,
    visible:
      property.id === propertyId ? !visibleIds.has(property.id) : visibleIds.has(property.id),
    // Fixed-width index keys: the UI always rewrites the whole list, so a
    // fractional index would buy nothing here.
    orderKey: String(index).padStart(4, '0'),
  }));
}

/** One step left or right, for a column and for a view tab alike. */
export type MoveDirection = 'left' | 'right';

/**
 * Where a column lands when it moves one step, in the database's own order.
 *
 * `afterPropertyId: null` means the front of the row. Used for the views that
 * have no order of their own, which is every view until somebody hides a
 * column: `visibleTableProperties` falls back to the property order, so moving
 * the property is what a person sees happen.
 */
export function columnMoveAfter(
  columns: DatabaseProperty[],
  propertyId: string,
  direction: MoveDirection,
): { afterPropertyId: string | null } | null {
  const index = columns.findIndex((property) => property.id === propertyId);
  if (index === -1) return null;
  if (direction === 'left') {
    if (index === 0) return null;
    return { afterPropertyId: columns[index - 2]?.id ?? null };
  }
  const next = columns[index + 1];
  if (next === undefined) return null;
  return { afterPropertyId: next.id };
}

/**
 * The same move inside one view's own column order.
 *
 * Once a view has an explicit order -- hiding a column writes one -- the
 * database's property order no longer decides what that view shows, so moving
 * the property would change nothing visible. This rewrites the view's list
 * instead, and leaves every other view where it was.
 */
export function moveColumnInView(
  view: DatabaseView,
  properties: DatabaseProperty[],
  propertyId: string,
  direction: MoveDirection,
): DatabaseViewConfig['visibleProperties'] | null {
  const ordered = visibleTableProperties(view, properties);
  const index = ordered.findIndex((property) => property.id === propertyId);
  const target = direction === 'left' ? index - 1 : index + 1;
  const moving = ordered[index];
  const displaced = ordered[target];
  if (moving === undefined || displaced === undefined) return null;

  const swapped = [...ordered];
  swapped[index] = displaced;
  swapped[target] = moving;

  const visibleIds = new Set(ordered.map((property) => property.id));
  const displayOrder = [
    ...swapped,
    ...properties.filter((property) => !visibleIds.has(property.id)),
  ];
  return displayOrder.map((property, position) => ({
    propertyId: property.id,
    visible: visibleIds.has(property.id),
    orderKey: String(position).padStart(4, '0'),
  }));
}

/** Whether this view carries a column order of its own. */
export function hasOwnColumnOrder(view: DatabaseView): boolean {
  return view.config.visibleProperties.length > 0;
}

export { DATABASE_TITLE_COLUMN_KEY };
