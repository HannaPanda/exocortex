import { z } from 'zod';

import { idSchema } from './primitives';

/**
 * Calendar synchronisation. A mirrored calendar is an ordinary database
 * (ADR-011): the collection is a `COLLECTION` document, every appointment is a
 * `PAGE` row underneath it, and the appointment's time is a DATE property with
 * `isRange: true` (see `databaseDatePropertyConfigSchema`).
 *
 * Nothing here models credentials. `CalendarAccount.credentialRef` names an
 * environment key; the secret lives in Infisical and reaches the worker through
 * the `.env` (deploy/README.md).
 */

export const calendarProviderSchema = z.enum(['CALDAV', 'GOOGLE']);
export type CalendarProvider = z.infer<typeof calendarProviderSchema>;

export const calendarSyncDirectionSchema = z.enum(['PULL', 'PUSH', 'BOTH']);
export type CalendarSyncDirection = z.infer<typeof calendarSyncDirectionSchema>;

export const calendarEventOriginSchema = z.enum(['LOCAL', 'REMOTE']);
export type CalendarEventOrigin = z.infer<typeof calendarEventOriginSchema>;

/**
 * Which property of the mirror database receives which iCalendar field.
 *
 * A JSON column validated at the boundary, the same pattern as
 * `DatabaseView.config`: the set of mapped fields grows as the sync learns more
 * of iCalendar, and a new field must not need a migration. Every entry is
 * nullable because a mirror is still useful without it -- a calendar with no
 * "Ort" column simply drops LOCATION rather than failing to sync.
 */
export const calendarLinkPropertyMapSchema = z.object({
  /** DATE property with `isRange: true`. Receives start, end and allDay. */
  date: idSchema.nullable().default(null),
  location: idSchema.nullable().default(null),
  description: idSchema.nullable().default(null),
  /**
   * Receives ORGANIZER. Empty for an event created here; filled means the event
   * came from an invitation and is not ours to rewrite.
   */
  organizer: idSchema.nullable().default(null),
  /** Receives our own PARTSTAT. Read-only until ITIP replies exist. */
  participation: idSchema.nullable().default(null),
  /** Receives the raw RRULE, so a recurring event is recognisable as one. */
  recurrence: idSchema.nullable().default(null),
  /** VTODO only: DUE. */
  due: idSchema.nullable().default(null),
  /** VTODO only: STATUS. */
  status: idSchema.nullable().default(null),
});
export type CalendarLinkPropertyMap = z.infer<typeof calendarLinkPropertyMapSchema>;

/** Never throws: an unparsable bag degrades to "nothing mapped". */
export function parseCalendarLinkPropertyMap(
  value: Record<string, unknown> | null | undefined,
): CalendarLinkPropertyMap {
  const parsed = calendarLinkPropertyMapSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : calendarLinkPropertyMapSchema.parse({});
}

/**
 * German column names the provisioning step creates and then looks up by.
 *
 * Names rather than a fixed order, so a human may reorder or hide the columns
 * without breaking the sync, and renaming one only costs that one field until
 * the link's `propertyMap` is repaired.
 */
export const CALENDAR_PROPERTY_NAMES = {
  date: 'Zeitraum',
  location: 'Ort',
  description: 'Beschreibung',
  organizer: 'Organisator',
  participation: 'Teilnahme',
  recurrence: 'Wiederholung',
  due: 'Fällig am',
  status: 'Status',
} as const satisfies Record<keyof CalendarLinkPropertyMap, string>;

export const calendarComponentSchema = z.enum(['VEVENT', 'VTODO']);
export type CalendarComponent = z.infer<typeof calendarComponentSchema>;
