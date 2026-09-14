'use client';

/**
 * A written record of what the two live channels actually did.
 *
 * The application socket and the collaboration connection fail in a way that
 * leaves no trace anywhere we can reach: the browser console stays empty
 * because nothing throws, and the server sees nothing because the socket is
 * never opened. On 2026-09-08 a tab fetched four valid collaboration tickets
 * in twelve seconds and opened no socket at all, with no error on either side.
 * Between "ticket granted" and "socket open" there is a stretch of client code
 * that only the client can describe, so it describes itself here.
 *
 * Three properties matter and each one is why a plainer `console.log` would not
 * have done:
 *
 *  - It survives a reload. The first instinct at a dead tab is F5, and that
 *    used to destroy the only evidence of what happened before it.
 *  - It is readable in one piece. `window.exocortex.dump()` returns the whole
 *    history as text, ready to paste, rather than a console full of collapsed
 *    objects that lose their contents when copied.
 *  - It is bounded. A ring buffer of {@link MAX_ENTRIES} entries and a size cap
 *    on the stored copy, so a tab left open for a week cannot fill the origin's
 *    storage quota and break the editor's offline copy.
 */

/** Where the history survives a reload. */
const STORAGE_KEY = 'exocortex.debug.connection';

/** Entries kept in memory and in storage. Roughly an hour of a bad connection. */
const MAX_ENTRIES = 400;

/** Never write more than this to storage, however long the details are. */
const MAX_STORED_BYTES = 128 * 1024;

/** Storage is written at most this often; the buffer in memory is always current. */
const PERSIST_DEBOUNCE_MS = 1_000;

/** Which of the two live channels an entry belongs to. */
export type ConnectionChannel = 'app' | 'collab' | 'probe';

/** Values a detail may carry. Deliberately not `unknown`: this gets serialized. */
export type ConnectionDetailValue = string | number | boolean | null;

export interface ConnectionLogEntry {
  /** Wall clock, so entries can be lined up against the server journals. */
  at: number;
  channel: ConnectionChannel;
  /** Short, stable, English identifier. Grep-able across a pasted dump. */
  event: string;
  detail?: Record<string, ConnectionDetailValue>;
}

let entries: ConnectionLogEntry[] = [];
let restored = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let consoleEnabled = true;

const browser = (): boolean => typeof window !== 'undefined';

/**
 * Reads back what an earlier page load wrote.
 *
 * Anything unparseable is dropped rather than repaired: this is a diagnostic
 * buffer, and a broken one must never be able to break the page that carries
 * it.
 */
function restore(): void {
  if (restored || !browser()) return;
  restored = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    entries = parsed.filter(
      (entry): entry is ConnectionLogEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ConnectionLogEntry).at === 'number' &&
        typeof (entry as ConnectionLogEntry).event === 'string',
    );
  } catch {
    entries = [];
  }
}

/**
 * Writes the buffer out, dropping the oldest entries until it fits.
 *
 * The cap is on the serialized bytes rather than the entry count, because one
 * entry carrying a long error message can be larger than a hundred ordinary
 * ones.
 */
function persist(): void {
  if (!browser()) return;
  try {
    let candidate = entries;
    let payload = JSON.stringify(candidate);
    while (payload.length > MAX_STORED_BYTES && candidate.length > 1) {
      candidate = candidate.slice(Math.ceil(candidate.length / 2));
      payload = JSON.stringify(candidate);
    }
    window.localStorage.setItem(STORAGE_KEY, payload);
  } catch {
    // A full or disabled storage must not take the page with it.
  }
}

function schedulePersist(): void {
  if (!browser() || persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persist();
  }, PERSIST_DEBOUNCE_MS);
}

/** `12:34:56.789` -- local time, to line up with what the user sees. */
function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(
    date.getMilliseconds(),
    3,
  )}`;
}

function formatDetail(detail: Record<string, ConnectionDetailValue> | undefined): string {
  if (detail === undefined) return '';
  const parts = Object.entries(detail).map(([key, value]) => `${key}=${String(value)}`);
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
}

/** One entry as a single line. The dump and the console agree on this format. */
export function formatEntry(entry: ConnectionLogEntry): string {
  return `${clock(entry.at)} [${entry.channel}] ${entry.event}${formatDetail(entry.detail)}`;
}

/**
 * Records one thing that happened on a live channel.
 *
 * Cheap enough to call on every status change: an object push, a console line
 * and a debounced write.
 */
export function logConnection(
  channel: ConnectionChannel,
  event: string,
  detail?: Record<string, ConnectionDetailValue>,
): void {
  restore();
  const entry: ConnectionLogEntry = { at: Date.now(), channel, event, ...(detail && { detail }) };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  if (consoleEnabled && browser()) {
    // eslint-disable-next-line no-console -- this module is the console output.
    console.info(`%c[exo]%c ${formatEntry(entry)}`, 'color:#F9AA33;font-weight:600', '');
  }
  schedulePersist();
}

/** The whole history as one block of text, ready to select and paste. */
export function dumpConnectionLog(): string {
  restore();
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) return 'No connection events recorded.';
  const header = `${entries.length} events, ${clock(first.at)} to ${clock(last.at)}`;
  return [header, ...entries.map(formatEntry)].join('\n');
}

/** The raw entries, for anyone who would rather filter them than read them. */
export function connectionLogEntries(): readonly ConnectionLogEntry[] {
  restore();
  return entries;
}

/** Empties the history, in memory and in storage. */
export function clearConnectionLog(): void {
  entries = [];
  if (browser()) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // See `persist`.
    }
  }
}

/** Stops the console output. The buffer keeps filling either way. */
export function setConnectionLogConsole(enabled: boolean): void {
  consoleEnabled = enabled;
}

// A tab that is closed or frozen mid-outage still has to leave its history
// behind, and the debounced write above may not have run yet. `pagehide` is the
// one event that fires in every case a tab goes away, including Firefox's
// back/forward cache and its tab unloading.
if (browser()) {
  window.addEventListener('pagehide', () => {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persist();
  });
}
