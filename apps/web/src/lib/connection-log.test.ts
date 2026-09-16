import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConnectionLogModule from './connection-log';

/**
 * The diagnostic buffer, tested against a stub `window`.
 *
 * It is the one module in this suite that touches the browser, and stubbing it
 * is not a workaround: what has to be provable is what ends up *in storage*
 * after a bad hour, and only a stub can be asked that.
 */

interface FakeStorage {
  store: Map<string, string>;
  failing: boolean;
}

function installWindow(initial?: string): FakeStorage {
  const state: FakeStorage = { store: new Map(), failing: false };
  if (initial !== undefined) state.store.set('exocortex.debug.connection', initial);

  const localStorage = {
    getItem: (key: string): string | null => state.store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      if (state.failing) throw new Error('QuotaExceededError');
      state.store.set(key, value);
    },
    removeItem: (key: string): void => {
      state.store.delete(key);
    },
  };

  vi.stubGlobal('window', { localStorage, addEventListener: (): void => undefined });
  return state;
}

/** A fresh copy of the module: it keeps its buffer in module scope. */
async function loadLog(initial?: string): Promise<{
  storage: FakeStorage;
  log: typeof ConnectionLogModule;
}> {
  vi.resetModules();
  const storage = installWindow(initial);
  const log = await import('./connection-log');
  log.setConnectionLogConsole(false);
  return { storage, log };
}

const STORAGE_KEY = 'exocortex.debug.connection';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-16T12:34:56.789Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('formatEntry', () => {
  it('writes one grep-able line per event', async () => {
    const { log } = await loadLog();
    log.logConnection('collab', 'socket.open', { attempt: 2, url: '/collab' });

    const [entry] = log.connectionLogEntries();
    expect(entry).toBeDefined();
    expect(log.formatEntry(entry!)).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d \[collab\] socket\.open /);
    expect(log.formatEntry(entry!)).toContain('attempt=2 url=/collab');
  });

  it('leaves the detail off when there is none', async () => {
    const { log } = await loadLog();
    log.logConnection('app', 'page.load');

    expect(log.formatEntry(log.connectionLogEntries()[0]!)).toMatch(/\[app\] page\.load$/);
  });
});

describe('the ring buffer', () => {
  it('keeps the newest 400 events and drops the rest', async () => {
    const { log } = await loadLog();
    for (let index = 0; index < 450; index += 1) log.logConnection('app', `event.${String(index)}`);

    const entries = log.connectionLogEntries();
    expect(entries.length).toBe(400);
    expect(entries[0]?.event).toBe('event.50');
    expect(entries.at(-1)?.event).toBe('event.449');
  });
});

describe('what survives a reload', () => {
  it('reads an earlier page load back', async () => {
    const stored = JSON.stringify([{ at: Date.now(), channel: 'app', event: 'socket.close' }]);
    const { log } = await loadLog(stored);

    expect(log.connectionLogEntries().map((entry) => entry.event)).toEqual(['socket.close']);
  });

  it('drops entries that read back malformed instead of repairing them', async () => {
    const stored = JSON.stringify([
      { at: 1, channel: 'app', event: 'kept' },
      { channel: 'app', event: 'no timestamp' },
      'not an object',
      null,
    ]);
    const { log } = await loadLog(stored);

    expect(log.connectionLogEntries().map((entry) => entry.event)).toEqual(['kept']);
  });

  it('starts empty when the stored value is not JSON', async () => {
    const { log } = await loadLog('{ broken');

    expect(log.connectionLogEntries()).toEqual([]);
  });

  it('writes to storage once the debounce has passed, not before', async () => {
    const { log, storage } = await loadLog();
    log.logConnection('app', 'page.load');

    expect(storage.store.has(STORAGE_KEY)).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(storage.store.get(STORAGE_KEY)).toContain('page.load');
  });

  it('drops the oldest half until the write fits the size cap', async () => {
    const { log, storage } = await loadLog();
    const long = 'x'.repeat(2_000);
    for (let index = 0; index < 400; index += 1) {
      log.logConnection('collab', `event.${String(index)}`, { note: long });
    }
    vi.advanceTimersByTime(1_000);

    const payload = storage.store.get(STORAGE_KEY) ?? '';
    expect(payload.length).toBeLessThanOrEqual(128 * 1024);
    // The buffer in memory is untouched; only the stored copy is trimmed, and
    // what it keeps is the recent end.
    expect(log.connectionLogEntries().length).toBe(400);
    expect(payload).toContain('event.399');
    expect(payload).not.toContain('"event.0"');
  });

  it('keeps recording when storage refuses to take it', async () => {
    const { log, storage } = await loadLog();
    storage.failing = true;
    log.logConnection('app', 'page.load');
    vi.advanceTimersByTime(1_000);

    expect(log.connectionLogEntries().length).toBe(1);
  });
});

describe('dumpConnectionLog', () => {
  it('says so when there is nothing to show', async () => {
    const { log } = await loadLog();

    expect(log.dumpConnectionLog()).toBe('No connection events recorded.');
  });

  it('puts a countable header above the lines', async () => {
    const { log } = await loadLog();
    log.logConnection('app', 'first');
    log.logConnection('probe', 'second');

    const lines = log.dumpConnectionLog().split('\n');
    expect(lines[0]).toMatch(/^2 events, \d\d:\d\d:\d\d\.\d\d\d to \d\d:\d\d:\d\d\.\d\d\d$/);
    expect(lines).toHaveLength(3);
  });
});

describe('clearConnectionLog', () => {
  it('empties the buffer and the stored copy', async () => {
    const { log, storage } = await loadLog();
    log.logConnection('app', 'page.load');
    vi.advanceTimersByTime(1_000);

    log.clearConnectionLog();

    expect(log.connectionLogEntries()).toEqual([]);
    expect(storage.store.has(STORAGE_KEY)).toBe(false);
  });
});
