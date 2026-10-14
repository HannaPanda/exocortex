import { describe, expect, it } from 'vitest';

import { REASONING_FLUSH_INTERVAL_MS, ReasoningRelay } from './reasoning-relay';

function relayWithClock() {
  let now = 1_000;
  const published: { turn: number; delta: string; sequence: number }[] = [];
  const relay = new ReasoningRelay(
    async (payload) => {
      published.push(payload);
    },
    () => now,
  );
  return {
    relay,
    published,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ReasoningRelay', () => {
  it('collects fragments until the interval has passed', async () => {
    const { relay, published, advance } = relayWithClock();
    await relay.startTurn(1);
    await relay.push('Ich ');
    await relay.push('überlege');
    expect(published).toEqual([]);

    advance(REASONING_FLUSH_INTERVAL_MS);
    await relay.push(' kurz.');

    expect(published).toEqual([{ turn: 1, delta: 'Ich überlege kurz.', sequence: 1 }]);
  });

  it('hands on what is waiting when flushed, and nothing twice', async () => {
    const { relay, published } = relayWithClock();
    await relay.startTurn(1);
    await relay.push('Erst das.');
    await relay.flush();
    await relay.flush();

    expect(published).toEqual([{ turn: 1, delta: 'Erst das.', sequence: 1 }]);
  });

  it('keeps the thinking of two turns apart', async () => {
    const { relay, published } = relayWithClock();
    await relay.startTurn(1);
    await relay.push('Vor dem Werkzeug.');
    await relay.startTurn(2);
    await relay.push('Danach.');
    await relay.flush();

    expect(published).toEqual([
      { turn: 1, delta: 'Vor dem Werkzeug.', sequence: 1 },
      { turn: 2, delta: 'Danach.', sequence: 2 },
    ]);
  });

  it('publishes nothing for empty fragments', async () => {
    const { relay, published } = relayWithClock();
    await relay.push('');
    await relay.flush();

    expect(published).toEqual([]);
  });
});
