/**
 * CalDAV and iCalendar. Protocol only: this package talks to a remote calendar
 * server and turns its answers into typed values. It knows nothing about
 * documents, databases or workspaces, and the dependency graph keeps it that
 * way (`scripts/dependency-graph.mjs`).
 */
export { CalDavError, DavClient, type DavClientOptions, type FetchLike } from './dav-client';
export {
  discoverCalendarHome,
  discoverCalendars,
  discoverPrincipal,
  listCollections,
} from './discovery';
export { parseCalendarObject, type ParseOptions } from './ics';
export { buildEventIcs, patchEventIcs, type WriteEventOptions } from './ics-write';
export { type CalendarEventPayload, hashCalendarEventPayload, newCalendarUid } from './payload';
export { describeRecurrence, resolveOccurrence, type ResolveOccurrenceOptions } from './recurrence';
export { fetchObjects, fetchObjectsInRange, listObjects, syncCollection, toIcalUtc } from './sync';
export type {
  CalDavCredentials,
  CalendarCollection,
  CalendarObject,
  CalendarObjectRef,
  CalendarOccurrence,
  ParsedCalendarEvent,
  ParsedCalendarObject,
  ParsedCalendarTodo,
  SyncDelta,
  TimeRange,
} from './types';
export {
  calendarObjectHref,
  deleteCalendarObject,
  putCalendarObject,
  type PutCalendarObjectInput,
  type PutCalendarObjectResult,
} from './write';
