import {
  type DatabaseFilterCondition,
  type DatabaseFilterGroup,
  databaseFilterGroupSchema,
  type DatabaseSort,
  databaseSortSchema,
  databaseViewConfigSchema,
  parseDatePropertyConfig,
} from '@exocortex/contracts';
import {
  buildPropertyMap,
  type DatabasePropertyType,
  type DatabaseViewType,
  type PrismaClient,
  queryDatabaseRows,
  UnknownDatabasePropertyError,
} from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

/**
 * How many rows of the open view are shown. Enough to recognise the shape of
 * the data ("these are invoices, mostly unpaid"), far too few to be a substitute
 * for querying it -- which is the point: `exo_database_query` exists for that
 * and does not have to guess the filters.
 */
const MAX_ROWS = 10;

/** Per-cell cap, so one long text column cannot crowd out every other column. */
const MAX_CELL_CHARS = 80;

/** Options are listed so the model can filter by them; a huge option list is cut. */
const MAX_OPTIONS_LISTED = 12;

const PROPERTY_TYPE_LABEL: Record<DatabasePropertyType, string> = {
  TEXT: 'Text',
  NUMBER: 'Zahl',
  SELECT: 'Auswahl',
  MULTI_SELECT: 'Mehrfachauswahl',
  DATE: 'Datum',
  CHECKBOX: 'Ja/Nein',
  URL: 'URL',
  EMAIL: 'E-Mail',
  PHONE: 'Telefon',
  PERSON: 'Person',
  FILES: 'Dateien',
  CREATED_TIME: 'Erstellt am',
  UPDATED_TIME: 'Geändert am',
  CREATED_BY: 'Erstellt von',
  UPDATED_BY: 'Geändert von',
  RELATION: 'Verknüpfung',
  ROLLUP: 'Rollup',
  FORMULA: 'Formel',
};

const VIEW_TYPE_LABEL: Record<DatabaseViewType, string> = {
  TABLE: 'Tabelle',
  BOARD: 'Board',
  GALLERY: 'Galerie',
  CALENDAR: 'Kalender',
};

const OPERATOR_LABEL: Record<DatabaseFilterCondition['operator'], string> = {
  equals: 'ist',
  not_equals: 'ist nicht',
  contains: 'enthält',
  not_contains: 'enthält nicht',
  is_empty: 'ist leer',
  is_not_empty: 'ist nicht leer',
  greater_than: 'größer als',
  less_than: 'kleiner als',
  on_or_after: 'am oder nach',
  on_or_before: 'am oder vor',
  overlaps: 'liegt im Zeitraum',
};

const COMPUTED_TYPES = new Set<DatabasePropertyType>([
  'CREATED_TIME',
  'UPDATED_TIME',
  'CREATED_BY',
  'UPDATED_BY',
]);
const ARRAY_TYPES = new Set<DatabasePropertyType>(['MULTI_SELECT', 'PERSON', 'FILES']);

interface PropertyRow {
  id: string;
  name: string;
  type: DatabasePropertyType;
  /** Read for DATE: decides whether the cell carries a time and an end. */
  config: Record<string, unknown> | null;
  options: { id: string; label: string }[];
}

function isFilterGroup(node: DatabaseFilterCondition | DatabaseFilterGroup): node is DatabaseFilterGroup {
  return 'combinator' in node;
}

function truncateCell(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_CELL_CHARS ? `${collapsed.slice(0, MAX_CELL_CHARS)}…` : collapsed;
}

/** Renders one filter tree as a German sentence, resolving ids to names and option labels. */
function describeFilters(
  group: DatabaseFilterGroup,
  properties: ReadonlyMap<string, PropertyRow>,
): string | null {
  const parts: string[] = [];
  for (const node of group.conditions) {
    if (isFilterGroup(node)) {
      const nested = describeFilters(node, properties);
      if (nested !== null) parts.push(`(${nested})`);
      continue;
    }
    const property = properties.get(node.propertyId);
    // A filter referencing a deleted property is not rendered as a dangling id:
    // saying nothing is better than saying something the user cannot place.
    if (property === undefined) continue;

    const operator = OPERATOR_LABEL[node.operator];
    if (node.value === undefined) {
      parts.push(`${property.name} ${operator}`);
      continue;
    }
    const raw = Array.isArray(node.value) ? node.value : [node.value];
    const labels = raw.map((entry) => {
      const option = property.options.find((candidate) => candidate.id === entry);
      return option?.label ?? String(entry);
    });
    parts.push(`${property.name} ${operator} „${labels.join('“, „')}“`);
  }
  if (parts.length === 0) return null;
  return parts.join(group.combinator === 'and' ? ' und ' : ' oder ');
}

function describeSorts(
  sorts: readonly DatabaseSort[],
  properties: ReadonlyMap<string, PropertyRow>,
): string | null {
  const parts = sorts
    .map((sort) => {
      const property = properties.get(sort.propertyId);
      if (property === undefined) return null;
      return `${property.name} ${sort.direction === 'asc' ? 'aufsteigend' : 'absteigend'}`;
    })
    .filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * Describes a database page the way it is actually on screen: its columns, the
 * open view's filters and sorts, and the first rows that view produces.
 *
 * Rendering a collection as prose would be nonsense -- a database is a shape,
 * not a text. Rendering it without the open view would be worse than nonsense:
 * it would describe a different table than the one the user is looking at, and
 * "how many are still open" would get an answer about the wrong set.
 *
 * Everything here is best-effort. A malformed filter blob, a view that has been
 * deleted or a failing row query degrades the description rather than the run:
 * the model still learns the columns, and it still has `exo_database_query`.
 */
export async function describeCollection(input: {
  prisma: PrismaClient;
  workspaceId: string;
  documentId: string;
  /** The view the user has open; `null` falls back to the first one, as the UI does. */
  viewId: string | null;
  logger: Logger;
}): Promise<string | null> {
  const { prisma, workspaceId, documentId, viewId, logger } = input;

  const [propertyRows, viewRows] = await Promise.all([
    prisma.databaseProperty.findMany({
      where: { documentId },
      orderBy: { orderKey: 'asc' },
      select: {
        id: true,
        name: true,
        type: true,
        config: true,
        options: { orderBy: { orderKey: 'asc' }, select: { id: true, label: true } },
      },
    }),
    prisma.databaseView.findMany({
      where: { documentId },
      orderBy: { orderKey: 'asc' },
      select: {
        id: true,
        name: true,
        type: true,
        filters: true,
        sorts: true,
        groupByPropertyId: true,
        config: true,
      },
    }),
  ]);

  if (propertyRows.length === 0 && viewRows.length === 0) return null;

  const properties: PropertyRow[] = propertyRows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    config: (row.config ?? null) as Record<string, unknown> | null,
    options: row.options,
  }));
  const propertiesById = new Map(properties.map((property) => [property.id, property]));

  const sections: string[] = [];

  if (properties.length > 0) {
    const lines = properties.map((property) => {
      const label = PROPERTY_TYPE_LABEL[property.type];
      if (property.options.length === 0) return `- ${property.name} (${label})`;
      const shown = property.options.slice(0, MAX_OPTIONS_LISTED).map((option) => option.label);
      const rest = property.options.length - shown.length;
      const suffix = rest > 0 ? `, … ${rest} weitere` : '';
      return `- ${property.name} (${label}: ${shown.join(', ')}${suffix})`;
    });
    sections.push(['### Spalten', ...lines].join('\n'));
  }

  // The UI falls back to the first view when the selected one is gone, so the
  // description has to fall back the same way or it would describe a view the
  // user cannot see.
  const view = (viewId === null ? undefined : viewRows.find((row) => row.id === viewId)) ?? viewRows[0];
  if (view === undefined) return sections.length === 0 ? null : sections.join('\n\n');

  const filters = databaseFilterGroupSchema.safeParse(view.filters);
  const sorts = databaseSortSchema.array().safeParse(view.sorts);
  const config = databaseViewConfigSchema.safeParse(view.config);
  if (!filters.success || !sorts.success) {
    logger.info('Database view has a filter or sort blob that no longer parses', {
      documentId,
      viewId: view.id,
      workspaceId,
    });
  }

  const filterGroup = filters.success ? filters.data : { combinator: 'and' as const, conditions: [] };
  const sortList = sorts.success ? sorts.data : [];

  const viewLines = [`### Offene Ansicht „${view.name}“ (${VIEW_TYPE_LABEL[view.type]})`];
  const filterText = describeFilters(filterGroup, propertiesById);
  viewLines.push(filterText === null ? 'Filter: keiner' : `Filter: ${filterText}`);
  const sortText = describeSorts(sortList, propertiesById);
  if (sortText !== null) viewLines.push(`Sortierung: ${sortText}`);
  if (view.groupByPropertyId !== null) {
    const groupProperty = propertiesById.get(view.groupByPropertyId);
    if (groupProperty !== undefined) viewLines.push(`Gruppiert nach: ${groupProperty.name}`);
  }
  sections.push(viewLines.join('\n'));

  // Only the columns the view actually shows: an invisible column is not part
  // of what the user is looking at.
  const visibleIds = config.success
    ? new Set(
        config.data.visibleProperties
          .filter((entry) => entry.visible)
          .map((entry) => entry.propertyId),
      )
    : null;
  const columns =
    visibleIds === null || visibleIds.size === 0
      ? properties
      : properties.filter((property) => visibleIds.has(property.id));

  const rowSection = await describeRows({
    prisma,
    workspaceId,
    documentId,
    properties,
    columns,
    filters: filterGroup,
    sorts: sortList,
    logger,
  });
  if (rowSection !== null) sections.push(rowSection);

  return sections.join('\n\n');
}

async function describeRows(input: {
  prisma: PrismaClient;
  workspaceId: string;
  documentId: string;
  properties: readonly PropertyRow[];
  columns: readonly PropertyRow[];
  filters: DatabaseFilterGroup;
  sorts: readonly DatabaseSort[];
  logger: Logger;
}): Promise<string | null> {
  const { prisma, workspaceId, documentId, properties, columns, filters, sorts, logger } = input;

  let rows;
  try {
    rows = await queryDatabaseRows(prisma, {
      workspaceId,
      collectionDocumentId: documentId,
      properties: buildPropertyMap(properties.map((property) => ({ id: property.id, type: property.type }))),
      filters,
      sorts: [...sorts],
      // One more than shown, so "there are further rows" is a fact rather than
      // a guess, without paying for a second counting query.
      limit: MAX_ROWS + 1,
      offset: 0,
    });
  } catch (error) {
    // A filter referencing a property from elsewhere is rejected by the query
    // engine on purpose (`UnknownDatabasePropertyError`). Losing the row sample
    // over it is fine; losing the whole answer would not be.
    logger.info('Skipping the row sample for the open database view', {
      documentId,
      workspaceId,
      reason: error instanceof UnknownDatabasePropertyError ? 'unknown property in view' : 'query failed',
    });
    return null;
  }

  if (rows.length === 0) return '### Zeilen\nDiese Ansicht enthält keine Zeilen.';

  const hasMore = rows.length > MAX_ROWS;
  const shown = rows.slice(0, MAX_ROWS);

  const storedValues = await prisma.documentPropertyValue.findMany({
    where: { documentId: { in: shown.map((row) => row.id) } },
    select: {
      documentId: true,
      propertyId: true,
      textValue: true,
      numberValue: true,
      boolValue: true,
      dateValue: true,
      dateEndValue: true,
      dateAllDay: true,
      jsonValue: true,
    },
  });
  const valuesByRow = new Map<string, Map<string, (typeof storedValues)[number]>>();
  for (const value of storedValues) {
    const perRow = valuesByRow.get(value.documentId) ?? new Map();
    perRow.set(value.propertyId, value);
    valuesByRow.set(value.documentId, perRow);
  }

  const header = ['Titel', ...columns.map((column) => column.name)];
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];

  for (const row of shown) {
    const cells = [truncateCell(row.title)];
    for (const column of columns) {
      cells.push(
        truncateCell(
          renderValue(column, valuesByRow.get(row.id)?.get(column.id), {
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            createdById: row.createdById,
            updatedById: row.updatedById,
          }),
        ),
      );
    }
    lines.push(`| ${cells.join(' | ')} |`);
  }

  const heading = hasMore
    ? `### Zeilen (die ersten ${MAX_ROWS}, es gibt weitere)`
    : `### Zeilen (alle ${shown.length})`;
  const footer = hasMore
    ? '\nFür den Rest oder für Auswertungen nutze `exo_database_query` statt zu schätzen.'
    : '';
  return `${heading}\n${lines.join('\n')}${footer}`;
}

interface ComputedSource {
  createdAt: Date;
  updatedAt: Date;
  createdById: string;
  updatedById: string;
}

interface StoredValue {
  textValue: string | null;
  numberValue: unknown;
  boolValue: boolean | null;
  dateValue: Date | null;
  dateEndValue: Date | null;
  dateAllDay: boolean | null;
  jsonValue: unknown;
}

/**
 * A DATE cell as text for the prompt. The time of day and the end are part of
 * what a date *means* once the property is a calendar: an appointment rendered
 * as a bare day would let the model answer "when?" with the wrong hour, and a
 * multi-day span rendered as its start day would lose the duration entirely.
 *
 * ISO throughout rather than German formatting: this is model input, and an
 * unambiguous instant travels better than a locale.
 */
function renderDateValue(property: PropertyRow, stored: StoredValue): string {
  if (stored.dateValue === null) return '';
  const config = parseDatePropertyConfig(property.config);
  const withTime = config.includeTime && stored.dateAllDay !== true;
  const format = (date: Date) => (withTime ? date.toISOString() : date.toISOString().slice(0, 10));

  const start = format(stored.dateValue);
  if (!config.isRange || stored.dateEndValue === null) return start;
  return `${start} bis ${format(stored.dateEndValue)}`;
}

/** One cell as text. Option ids become their labels; everything else stays literal. */
function renderValue(
  property: PropertyRow,
  stored: StoredValue | undefined,
  computed: ComputedSource,
): string {
  if (COMPUTED_TYPES.has(property.type)) {
    switch (property.type) {
      case 'CREATED_TIME':
        return computed.createdAt.toISOString().slice(0, 10);
      case 'UPDATED_TIME':
        return computed.updatedAt.toISOString().slice(0, 10);
      case 'CREATED_BY':
        return computed.createdById;
      default:
        return computed.updatedById;
    }
  }

  if (stored === undefined) return '';

  if (property.type === 'NUMBER') {
    return stored.numberValue === null || stored.numberValue === undefined
      ? ''
      : String(stored.numberValue);
  }
  if (property.type === 'CHECKBOX') {
    return stored.boolValue === null ? '' : stored.boolValue ? 'ja' : 'nein';
  }
  if (property.type === 'DATE') {
    return renderDateValue(property, stored);
  }
  if (ARRAY_TYPES.has(property.type)) {
    const ids = Array.isArray(stored.jsonValue) ? (stored.jsonValue as unknown[]) : [];
    return ids
      .map((id) => property.options.find((option) => option.id === id)?.label ?? String(id))
      .join(', ');
  }
  if (property.type === 'SELECT') {
    if (stored.textValue === null) return '';
    return property.options.find((option) => option.id === stored.textValue)?.label ?? stored.textValue;
  }
  return stored.textValue ?? '';
}
