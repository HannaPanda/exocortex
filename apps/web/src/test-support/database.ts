import {
  type DatabaseProperty,
  type DatabasePropertyType,
  type DatabaseView,
  type DatabaseViewConfig,
  EMPTY_DATABASE_FILTER_GROUP,
} from '@exocortex/contracts';

/**
 * Fully typed database fixtures.
 *
 * Same reason as the tree fixture: the column helpers read three fields of a
 * view and two of a property, and building the whole shape is what keeps a test
 * honest the day one of them starts reading a fourth.
 */
export function databaseProperty(
  id: string,
  overrides: Partial<DatabaseProperty> = {},
): DatabaseProperty {
  return {
    id,
    documentId: 'db',
    type: 'TEXT' as DatabasePropertyType,
    name: id,
    orderKey: id,
    config: null,
    options: [],
    createdAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

export function databaseView(config: Partial<DatabaseViewConfig> = {}): DatabaseView {
  return {
    id: 'view',
    documentId: 'db',
    type: 'TABLE',
    name: 'Tabelle',
    orderKey: 'a0',
    filters: EMPTY_DATABASE_FILTER_GROUP,
    sorts: [],
    groupByPropertyId: null,
    config: {
      visibleProperties: [],
      columnWidths: {},
      rowHeight: 'short',
      calendarMode: 'MONTH',
      ...config,
    },
    createdAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-16T10:00:00.000Z',
  };
}

/** `visibleProperties` the way the UI writes it: dense, zero-padded order keys. */
export function visibleProperties(
  entries: readonly (readonly [propertyId: string, visible: boolean])[],
): DatabaseViewConfig['visibleProperties'] {
  return entries.map(([propertyId, visible], index) => ({
    propertyId,
    visible,
    orderKey: String(index).padStart(4, '0'),
  }));
}
