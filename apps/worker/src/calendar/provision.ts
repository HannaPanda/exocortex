import { type CalendarCollection } from '@exocortex/calendar';
import {
  CALENDAR_PROPERTY_NAMES,
  type CalendarComponent,
  type CalendarLinkPropertyMap,
  type DatabaseProperty,
  databasePropertyListResponseSchema,
  databasePropertySchema,
  documentSummarySchema,
  parseCalendarLinkPropertyMap,
} from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';

/**
 * Which fields a mirror database carries, per component. A VTODO calendar has no
 * organizer and no recurrence column; giving it one would be six empty columns
 * in every task list.
 */
const FIELDS_BY_COMPONENT: Record<CalendarComponent, readonly (keyof CalendarLinkPropertyMap)[]> = {
  VEVENT: ['date', 'location', 'description', 'organizer', 'participation', 'recurrence'],
  VTODO: ['due', 'status', 'description'],
};

/** DATE for the time fields, plain TEXT for the rest. */
function propertyTypeFor(field: keyof CalendarLinkPropertyMap): 'DATE' | 'TEXT' {
  return field === 'date' || field === 'due' ? 'DATE' : 'TEXT';
}

/**
 * Makes sure the mirror database has the columns the sync writes, and returns
 * the resulting property map.
 *
 * Idempotent and by *name*: an existing column with the right name is adopted
 * rather than duplicated, so running this twice does not produce "Ort" and
 * "Ort 2", and a human may reorder or hide the columns freely.
 *
 * The DATE column is configured as a span with a time (`isRange`,
 * `includeTime`). That is not decoration: without `isRange` the property can
 * only hold a single instant, and every appointment would lose its end.
 */
export async function ensureMirrorProperties(input: {
  client: ExocortexApiClient;
  documentId: string;
  component: CalendarComponent;
  timeZone: string | null;
  logger: Logger;
}): Promise<CalendarLinkPropertyMap> {
  const existing = await input.client.request({
    method: 'GET',
    path: `/api/documents/${input.documentId}/properties`,
    responseSchema: databasePropertyListResponseSchema,
  });
  const byName = new Map(existing.properties.map((property) => [property.name, property]));

  const map: Record<string, string | null> = {};
  for (const field of FIELDS_BY_COMPONENT[input.component]) {
    const name = CALENDAR_PROPERTY_NAMES[field];
    const type = propertyTypeFor(field);
    let property = byName.get(name) ?? null;

    if (property !== null && property.type !== type) {
      // A name collision with a different type is left alone rather than
      // "fixed": deleting someone's column to make room for ours would destroy
      // data. The field stays unmapped and the sync simply skips it.
      input.logger.warn('Calendar mirror column has an unexpected type, leaving it unmapped', {
        documentId: input.documentId,
        name,
        expected: type,
        found: property.type,
      });
      map[field] = null;
      continue;
    }

    if (property === null) {
      property = await input.client.request({
        method: 'POST',
        path: `/api/documents/${input.documentId}/properties`,
        body: { type, name },
        responseSchema: databasePropertySchema,
      });
      byName.set(name, property);
    }

    if (type === 'DATE') {
      property = await ensureDateSpan(input.client, input.documentId, property, input.timeZone);
    }
    map[field] = property.id;
  }
  return parseCalendarLinkPropertyMap(map);
}

/**
 * Turns a DATE property into a timed span, unless it already is one.
 *
 * The write is skipped when the config already matches, because the API refuses
 * to turn `isRange` off while rows carry an end and an unnecessary PATCH would
 * be one more thing that can fail mid-sync for no gain.
 */
async function ensureDateSpan(
  client: ExocortexApiClient,
  documentId: string,
  property: DatabaseProperty,
  timeZone: string | null,
): Promise<DatabaseProperty> {
  const config = property.config ?? {};
  if (config.isRange === true && config.includeTime === true) return property;

  return client.request({
    method: 'PATCH',
    // Nested under the collection, not `/api/properties/:id`: the controller is
    // mounted at `api/documents/:documentId/properties`, so the flat path 404s.
    path: `/api/documents/${documentId}/properties/${property.id}`,
    body: { config: { includeTime: true, isRange: true, timeZone } },
    responseSchema: databasePropertySchema,
  });
}

/**
 * Creates the COLLECTION document a calendar mirrors into.
 *
 * The calendar's own name is used, so what shows up in the sidebar is
 * recognisable ("Kalender", "Geburtstage", "Aufgaben") rather than an opaque
 * CalDAV path.
 */
export async function createMirrorDatabase(input: {
  client: ExocortexApiClient;
  workspaceId: string;
  parentId: string | null;
  collection: CalendarCollection;
}): Promise<string> {
  const created = await input.client.request({
    method: 'POST',
    path: `/api/workspaces/${input.workspaceId}/documents`,
    body: {
      title: input.collection.displayName,
      type: 'COLLECTION',
      parentId: input.parentId,
    },
    responseSchema: documentSummarySchema,
  });
  return created.id;
}

/**
 * The collections worth mirroring.
 *
 * The scheduling inbox and outbox are dropped: they are ITIP transport, not
 * calendars, and their contents are messages about events rather than the events
 * themselves. Anything advertising neither VEVENT nor VTODO is dropped too --
 * mailbox.org's outbox advertises no component at all, and its inbox advertises
 * only VAVAILABILITY.
 */
export function mirrorableCollections(
  collections: readonly CalendarCollection[],
): { collection: CalendarCollection; component: CalendarComponent }[] {
  const result: { collection: CalendarCollection; component: CalendarComponent }[] = [];
  for (const collection of collections) {
    if (collection.isScheduleCollection) continue;
    // A collection advertising both gets one link per component: the rows have
    // different shapes and belong in different databases.
    if (collection.components.includes('VEVENT')) {
      result.push({ collection, component: 'VEVENT' });
    }
    if (collection.components.includes('VTODO')) {
      result.push({ collection, component: 'VTODO' });
    }
  }
  return result;
}
