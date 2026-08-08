/** One day in milliseconds. An all-day end is exclusive, so this undoes it. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How far around "now" the sweep looks for appointments.
 *
 * Generously wide, and deliberately so: the exact decision is made per
 * appointment from its own span, and this query only has to avoid *missing* a
 * candidate. An all-day appointment is announced at a local hour that, in a zone
 * far enough ahead of UTC, falls on the day before its stored date, so a window
 * built from the lead time alone would silently skip it. Appointments within a day
 * and a half of now are a handful of rows either way.
 */
export const REMINDER_WINDOW_MS = 36 * 60 * 60 * 1000;
