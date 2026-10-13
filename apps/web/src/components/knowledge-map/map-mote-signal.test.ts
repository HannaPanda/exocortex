import { describe, expect, it } from 'vitest';

import {
  calmMs,
  DISTURBANCE_MS,
  disturbanceKind,
  disturbanceMs,
  flickerAt,
  flickerPeak,
  flickerSize,
  moteScale,
  TRAIL_POINTS,
  trailBrightness,
  trailSize,
} from './map-mote-signal';

/** A seeded generator, so a statistical test is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

describe('moteScale', () => {
  it('keeps every mote within a slight difference of the nominal size', () => {
    expect(moteScale(() => 0)).toBeCloseTo(0.88);
    expect(moteScale(() => 0.999_999)).toBeCloseTo(1.12);
  });
});

describe('the rhythm of disturbances', () => {
  it('keeps a mote calm about nine tenths of the time', () => {
    const random = seeded(7);
    let calm = 0;
    let disturbed = 0;
    for (let index = 0; index < 5_000; index += 1) {
      calm += calmMs(random);
      disturbed += disturbanceMs(random);
    }
    const share = calm / (calm + disturbed);
    expect(share).toBeGreaterThan(0.88);
    expect(share).toBeLessThan(0.95);
  });

  it('never lets two calms be alike in a rhythm', () => {
    const random = seeded(11);
    const gaps = Array.from({ length: 50 }, () => Math.round(calmMs(random)));
    expect(new Set(gaps).size).toBeGreaterThan(45);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(250);
  });

  it('lasts between 50 and 150 milliseconds', () => {
    expect(disturbanceMs(() => 0)).toBe(DISTURBANCE_MS[0]);
    expect(disturbanceMs(() => 0.999_999)).toBeCloseTo(DISTURBANCE_MS[1]);
  });

  it('flickers most often, jitters sometimes and glitches rarely', () => {
    const random = seeded(3);
    const counts = { flicker: 0, jitter: 0, glitch: 0 };
    for (let index = 0; index < 10_000; index += 1) counts[disturbanceKind(random)] += 1;
    expect(counts.flicker).toBeGreaterThan(counts.jitter);
    expect(counts.jitter).toBeGreaterThan(counts.glitch);
    expect(counts.glitch / 10_000).toBeLessThan(0.05);
  });
});

describe('a flicker', () => {
  it('starts and ends at the mote own brightness', () => {
    expect(flickerAt(0, 2, 0.3)).toBeCloseTo(1);
    expect(flickerAt(1, 2, 0.3)).toBeCloseTo(1);
  });

  it('strikes fast and dies slower', () => {
    expect(flickerAt(0.2, 2, 0)).toBeGreaterThan(flickerAt(0.8, 2, 0));
  });

  it('is mostly a flash and sometimes a dropout', () => {
    const random = seeded(5);
    const peaks = Array.from({ length: 2_000 }, () => flickerPeak(random));
    const flashes = peaks.filter((peak) => peak > 1).length;
    expect(flashes / peaks.length).toBeGreaterThan(0.6);
    expect(flashes).toBeLessThan(peaks.length);
  });

  it('changes the size less than the light', () => {
    expect(flickerSize(2) - 1).toBeLessThan(2 - 1);
    expect(flickerSize(0.4)).toBeGreaterThan(0.4);
  });
});

describe('the trail', () => {
  it('grows fainter and smaller away from the mote', () => {
    for (let index = 1; index < TRAIL_POINTS; index += 1) {
      expect(trailBrightness(index + 1)).toBeLessThan(trailBrightness(index));
      expect(trailSize(index + 1)).toBeLessThan(trailSize(index));
    }
    expect(trailBrightness(1)).toBeLessThan(1);
    expect(trailSize(TRAIL_POINTS)).toBeGreaterThan(0);
  });
});
