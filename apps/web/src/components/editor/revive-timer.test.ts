import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reviveRebuilds, reviveTimer } from './revive-timer';

describe('reviveTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds after 20 s, then doubles the delay per consecutive failure up to two minutes', async () => {
    const count = { current: 0 };
    const rebuild = vi.fn();
    const timer = reviveTimer(count, rebuild, () => {});
    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const before = Date.now();
      timer.schedule({ reason: 'ticket' });
      await vi.advanceTimersToNextTimerAsync();
      delays.push(Date.now() - before);
    }
    expect(delays).toEqual([20_000, 40_000, 80_000, 120_000, 120_000]);
    expect(rebuild).toHaveBeenCalledTimes(5);
  });

  it('keeps one pending rebuild when it is armed twice', async () => {
    const rebuild = vi.fn();
    const timer = reviveTimer({ current: 0 }, rebuild, () => {});
    timer.schedule({ reason: 'ticket' });
    timer.schedule({ reason: 'ticket' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('rebuilds at once on a wake signal and resets the backoff', async () => {
    const count = { current: 3 };
    const rebuild = vi.fn();
    const timer = reviveTimer(count, rebuild, () => {});
    timer.schedule({ reason: 'ticket' });
    timer.now();
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(count.current).toBe(0);
    // The pending rebuild is gone; nothing fires twice.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('does nothing after cancel', async () => {
    const rebuild = vi.fn();
    const timer = reviveTimer({ current: 0 }, rebuild, () => {});
    timer.schedule({ socket: 'disconnected' });
    timer.cancel();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(rebuild).not.toHaveBeenCalled();
  });
});

describe('reviveRebuilds', () => {
  it('reopens the socket for every state a new socket can change (issue #285)', () => {
    // Rebuilding would remount the editor and put the reader at the top.
    expect(reviveRebuilds('disconnected', false)).toBe(false);
    expect(reviveRebuilds('connecting', false)).toBe(false);
  });

  it('rebuilds from the ticket up when an open socket was refused', () => {
    expect(reviveRebuilds('connected', false)).toBe(true);
  });
});
