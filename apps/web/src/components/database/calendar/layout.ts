import { type CalendarEntry, compareTitles } from './entries';
import { addDays, startOfDay } from './range';

export const MINUTES_PER_DAY = 1440;

/**
 * How long a row with no stated end is drawn. The contract allows an
 * appointment without an end (`databaseDateRangeValueSchema`), and a zero-high
 * box on a time axis is invisible, so the time grid picks a length rather than
 * inventing one in the data.
 */
export const DEFAULT_EVENT_MINUTES = 60;

/** Below this a box has no room for its title, so it is drawn taller than it is long. */
export const MIN_VISIBLE_MINUTES = 30;

/** One timed entry placed on one day's axis. Percentages are left to the renderer. */
export interface PositionedEntry {
  entry: CalendarEntry;
  /** Wall-clock minutes from local midnight, clamped into this day. */
  startMinute: number;
  /** Clamped, and never closer to the start than `MIN_VISIBLE_MINUTES`. */
  endMinute: number;
  /** 0-based column within its overlap cluster. */
  column: number;
  /** How many columns the cluster needs, i.e. what to divide the width by. */
  columns: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

interface Placed extends PositionedEntry {
  clusterIndex: number;
}

function wallMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function spanOf(entry: CalendarEntry): { start: number; end: number } | null {
  const start = new Date(entry.start).getTime();
  if (Number.isNaN(start)) return null;
  if (entry.end === null) return { start, end: start + DEFAULT_EVENT_MINUTES * 60_000 };
  const end = new Date(entry.end).getTime();
  if (Number.isNaN(end) || end <= start) {
    return { start, end: start + DEFAULT_EVENT_MINUTES * 60_000 };
  }
  return { start, end };
}

/**
 * Lays the timed entries of one day out side by side.
 *
 * Wall-clock minutes rather than elapsed time, so the boxes keep lining up
 * with the hour rules on the day a DST change makes 23 or 25 hours long. All-day
 * entries are not handled here: they belong in the band above the axis, where
 * they do not compete for width with a 14:00 appointment. `locale` orders
 * the titles of two identical boxes.
 */
export function layoutDay(
  entries: readonly CalendarEntry[],
  day: Date,
  locale: string,
): PositionedEntry[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();

  const items: Placed[] = [];
  for (const entry of entries) {
    if (entry.allDay) continue;
    const span = spanOf(entry);
    if (span === null) continue;
    if (span.end <= dayStart || span.start >= dayEnd) continue;

    const continuesBefore = span.start < dayStart;
    const continuesAfter = span.end > dayEnd;
    const startMinute = continuesBefore ? 0 : wallMinutes(new Date(span.start));
    // `>= dayEnd` and not `>`: an appointment ending exactly at midnight ends
    // at the bottom of this day, not at minute 0 of it.
    const rawEnd = span.end >= dayEnd ? MINUTES_PER_DAY : wallMinutes(new Date(span.end));
    const endMinute = Math.min(
      MINUTES_PER_DAY,
      Math.max(rawEnd, startMinute + MIN_VISIBLE_MINUTES),
    );

    items.push({
      entry,
      startMinute,
      endMinute,
      column: 0,
      columns: 1,
      continuesBefore,
      continuesAfter,
      clusterIndex: 0,
    });
  }

  items.sort((left, right) => {
    if (left.startMinute !== right.startMinute) return left.startMinute - right.startMinute;
    // The longer of two appointments starting together takes the left column,
    // so the shorter one is not buried behind it.
    if (left.endMinute !== right.endMinute) return right.endMinute - left.endMinute;
    return compareTitles(locale, left.entry.row.document.title, right.entry.row.document.title);
  });

  // A cluster is a run of entries connected by overlap; width is divided within
  // it, so two appointments in the morning do not make the afternoon narrow.
  const columnsPerCluster: number[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;
  let clusterIndex = -1;

  for (const item of items) {
    if (item.startMinute >= clusterEnd) {
      if (clusterIndex >= 0) columnsPerCluster[clusterIndex] = columnEnds.length;
      clusterIndex += 1;
      columnEnds = [];
      clusterEnd = Number.NEGATIVE_INFINITY;
    }
    const free = columnEnds.findIndex((end) => end <= item.startMinute);
    const column = free === -1 ? columnEnds.length : free;
    columnEnds[column] = item.endMinute;
    item.column = column;
    item.clusterIndex = clusterIndex;
    clusterEnd = Math.max(clusterEnd, item.endMinute);
  }
  if (clusterIndex >= 0) columnsPerCluster[clusterIndex] = columnEnds.length;

  return items.map(({ clusterIndex: index, ...rest }) => ({
    ...rest,
    columns: columnsPerCluster[index] ?? 1,
  }));
}
