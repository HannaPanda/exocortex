import { describe, expect, it } from 'vitest';

import { type MapLink } from './map-model';
import {
  BURST_LIMIT,
  BURST_SPREAD_MS,
  burstPlan,
  convoySize,
  freshness,
  idleForward,
  idleRate,
  laneSpeed,
  moteBrightness,
} from './map-traffic';

function line(
  source: string,
  target: string,
  kind: MapLink['kind'] = 'link',
  weight = 0.5,
): MapLink {
  return { key: `${kind}:${source}|${target}`, source, target, kind, weight };
}

const half = (): number => 0.5;
const DAY = 86_400_000;

describe('laneSpeed', () => {
  it('drives a strong line faster than a weak one', () => {
    expect(laneSpeed(line('a', 'b', 'link', 1), half)).toBeGreaterThan(
      laneSpeed(line('a', 'b', 'link', 0.1), half),
    );
  });

  it('lets each mote drift around its lane', () => {
    const link = line('a', 'b', 'similar', 0.7);
    expect(laneSpeed(link, () => 0)).toBeLessThan(laneSpeed(link, () => 0.999));
  });
});

describe('burstPlan', () => {
  const links = [
    line('a', 'b', 'tree', 1),
    line('c', 'a', 'link', 0.9),
    line('a', 'd', 'similar', 0.8),
    line('x', 'y', 'link', 1),
  ];

  it('sends along every line of the point, the most important first', () => {
    const plan = burstPlan('a', 'write', links, () => 0);
    expect(plan.map((entry) => entry.link.kind)).toEqual(['link', 'similar', 'tree']);
    expect(plan.map((entry) => entry.delay)).toEqual([0, BURST_SPREAD_MS / 2, BURST_SPREAD_MS]);
  });

  it('flows out of a written page and into a read one', () => {
    const out = burstPlan('a', 'write', links, () => 0);
    const into = burstPlan('a', 'read', links, () => 0);
    // c -> a: leaving a means travelling backwards along it, arriving at a forwards.
    expect(out[0]?.forward).toBe(false);
    expect(into[0]?.forward).toBe(true);
    // a -> d: the other way round.
    expect(out[1]?.forward).toBe(true);
    expect(into[1]?.forward).toBe(false);
  });

  it('leaves a single line at once, give or take the jitter', () => {
    const [only] = burstPlan('x', 'created', links, () => 0);
    expect(only?.delay).toBe(0);
  });

  it('keeps a hub to its strongest lines', () => {
    const hub = Array.from({ length: BURST_LIMIT + 10 }, (_, index) =>
      line('hub', `n${index}`, 'link', index / 100),
    );
    const plan = burstPlan('hub', 'write', hub, () => 0);
    expect(plan).toHaveLength(BURST_LIMIT);
    expect(plan[0]?.link.weight).toBe((BURST_LIMIT + 9) / 100);
  });
});

describe('freshness', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');

  it('is 1 for a page changed just now and halves every two weeks', () => {
    expect(freshness({ editedAt: '2026-10-12T12:00:00Z' }, now)).toBe(1);
    expect(freshness({ editedAt: new Date(now - 14 * DAY).toISOString() }, now)).toBeCloseTo(0.5);
  });

  it('is 0 for a date it cannot read', () => {
    expect(freshness({ editedAt: 'nonsense' }, now)).toBe(0);
  });
});

describe('idleRate', () => {
  it('is busier between lively pages than in an archive', () => {
    const link = line('a', 'b');
    expect(idleRate(link, 1, 'normal')).toBeGreaterThan(idleRate(link, 0, 'normal'));
    expect(idleRate(link, 0, 'normal')).toBeGreaterThan(0);
  });

  it('carries nothing on the tree and on a faint similarity unless lit', () => {
    expect(idleRate(line('a', 'b', 'tree'), 1, 'normal')).toBe(0);
    expect(idleRate(line('a', 'b', 'similar', 0.4), 1, 'normal')).toBe(0);
    expect(idleRate(line('a', 'b', 'tree'), 0, 'lit')).toBeGreaterThan(0);
  });

  it('nearly silences a dimmed line', () => {
    const link = line('a', 'b');
    expect(idleRate(link, 1, 'dim')).toBeLessThan(idleRate(link, 1, 'normal') / 2);
  });
});

describe('the rest of the traffic', () => {
  it('sends mostly single motes, sometimes a convoy', () => {
    expect(convoySize(() => 0.9)).toBe(1);
    expect(convoySize(() => 0.2)).toBe(2);
    expect(convoySize(() => 0.01)).toBe(3);
  });

  it('follows a reference and either way on a similarity', () => {
    expect(idleForward(line('a', 'b', 'link'), () => 0.9)).toBe(true);
    expect(idleForward(line('a', 'b', 'similar'), () => 0.9)).toBe(false);
    expect(idleForward(line('a', 'b', 'similar'), () => 0.1)).toBe(true);
  });

  it('fades a mote in as it leaves and out as it arrives', () => {
    expect(moteBrightness(0)).toBe(0);
    expect(moteBrightness(0.5)).toBe(1);
    expect(moteBrightness(1)).toBe(0);
  });
});
