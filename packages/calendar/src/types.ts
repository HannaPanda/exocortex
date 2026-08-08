/**
 * The vocabulary this package speaks. Everything here is protocol-shaped, not
 * Exocortex-shaped: a `CalendarCollection` is a CalDAV collection on a remote
 * server, never a `Document`. Mapping one onto the other is the worker's job
 * (see `scripts/dependency-graph.mjs` for why this package cannot even see
 * `@exocortex/database`).
 */

export interface CalDavCredentials {
  /** Entry point for discovery, e.g. `https://dav.mailbox.org/`. */
  baseUrl: string;
  username: string;
  /** App-specific password. Never logged, never included in an error message. */
  password: string;
}

/** A calendar on the server. `href` is its stable identity. */
export interface CalendarCollection {
  /** Server path, e.g. `/caldav/Y2FsOi8vMC8yNQ/`. */
  href: string;
  displayName: string;
  /** `VEVENT`, `VTODO`, … as advertised by `supported-calendar-component-set`. */
  components: string[];
  /**
   * Whether the server reports a `sync-token` for this collection.
   *
   * Not a formality: mailbox.org's generated "Geburtstage" calendar has none,
   * so it can only ever be read in full. A caller that assumes incremental sync
   * everywhere would silently never see a change there.
   */
  supportsSyncCollection: boolean;
  /** Cheap change detector for collections without a sync token. */
  ctag: string | null;
  /** True for the scheduling inbox/outbox, where invitations land. */
  isScheduleCollection: boolean;
}

/** A calendar object's identity and version, without its body. */
export interface CalendarObjectRef {
  href: string;
  /** Null when the server omits it; then the body is the only way to compare. */
  etag: string | null;
}

export interface CalendarObject extends CalendarObjectRef {
  /** Raw iCalendar text. Parse with `parseCalendarObject`. */
  ics: string;
}

/** Result of one incremental sync round. */
export interface SyncDelta {
  changed: CalendarObjectRef[];
  /** Hrefs the server reported as gone. */
  removed: string[];
  /** Pass back on the next round. Null means the server returned none. */
  syncToken: string | null;
  /**
   * The server rejected the token as too old. Everything must be re-read and
   * the local state rebuilt; treating this as "nothing changed" is how a sync
   * silently drifts.
   */
  resetRequired: boolean;
}

/**
 * One VEVENT, flattened into instants.
 *
 * `start`/`end` are ISO strings. For an all-day event they are the *floating*
 * calendar dates expressed at UTC midnight, which is exactly how Exocortex
 * stores an all-day span -- converting them into a zone would move birthdays.
 * `end` is exclusive, as in iCalendar: a one-day all-day event has an `end` of
 * the following day.
 */
export interface ParsedCalendarEvent {
  /** Stable across servers. The key that de-duplicates the same invitation. */
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: string;
  end: string | null;
  allDay: boolean;
  /** IANA zone the event was authored in, when the ICS says so. */
  timeZone: string | null;
  /** Raw RRULE, stored and expanded on read. Never materialized into rows. */
  rrule: string | null;
  /**
   * Whether this event repeats at all, by RRULE *or* by RDATE. The flag exists
   * because RDATE without RRULE is still a series, and `resolveOccurrence` is
   * what such an event needs.
   */
  recurs: boolean;
  /**
   * Set when this component overrides a single instance of a series
   * (RECURRENCE-ID). Such a component is not a separate appointment.
   */
  recurrenceId: string | null;
  /**
   * Present when the event arrived as an invitation. Then the organizer owns
   * it, and writing a changed time back would send an ITIP counter-proposal.
   */
  organizer: string | null;
  /** The account's own participation status, e.g. `ACCEPTED`, `NEEDS-ACTION`. */
  partStat: string | null;
  status: string | null;
  sequence: number;
  lastModified: string | null;
}

/** One VTODO. The shape the ToDos database syncs against. */
export interface ParsedCalendarTodo {
  uid: string;
  summary: string;
  description: string | null;
  /** Due date as an ISO string; null when the todo has none. */
  due: string | null;
  dueAllDay: boolean;
  /** `NEEDS-ACTION`, `IN-PROCESS`, `COMPLETED`, `CANCELLED`. */
  status: string | null;
  completedAt: string | null;
  percentComplete: number | null;
  priority: number | null;
  lastModified: string | null;
}

/**
 * One occurrence of a series, resolved out of its rule.
 *
 * The instants follow the same convention as `ParsedCalendarEvent`: all-day
 * values are floating dates at UTC midnight, `end` is exclusive, and a null
 * `end` means a point in time.
 */
export interface CalendarOccurrence {
  start: string;
  end: string | null;
  allDay: boolean;
  /**
   * The slot in the series this occurrence fills, as an ISO instant. Null for an
   * event that does not recur at all. Note that this is the *rule's* slot: for a
   * moved instance it differs from `start`, which is the point of a move.
   */
  recurrenceId: string | null;
  /** True when a RECURRENCE-ID override supplied this occurrence's times. */
  overridden: boolean;
  /**
   * True when the rule produces nothing after this occurrence, so a caller need
   * never ask again.
   */
  isFinal: boolean;
}

/**
 * What one calendar object contained. A single `.ics` resource holds a series
 * plus its overrides, so both lists can be longer than one entry.
 */
export interface ParsedCalendarObject {
  events: ParsedCalendarEvent[];
  todos: ParsedCalendarTodo[];
}

/** Half-open window `[start, end)` for a time-range query. */
export interface TimeRange {
  start: Date;
  end: Date;
}
