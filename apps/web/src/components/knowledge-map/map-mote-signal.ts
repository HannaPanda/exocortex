/**
 * The texture of a mote's signal (issue #189): how a data packet on a line
 * looks while it travels, as opposed to `map-traffic.ts`, which decides that
 * it travels at all. None of this carries information. It is noise, kept small
 * and rare on purpose, so the traffic still reads as facts: a mote glides
 * quietly about nine tenths of the time, and now and then, at its own moment
 * and never in step with another, its signal flickers, it jitters or, rarely,
 * it glitches for 50 to 150 milliseconds.
 *
 * Pure, with the randomness handed in, so a test can replay it.
 */

type Random = () => number;

/** Every mote is a little larger or smaller than the next, for as long as it lives. */
const SCALE_SPREAD = 0.24;

/** How much larger or smaller this mote is than the nominal size, around 1. */
export function moteScale(random: Random): number {
  return 1 - SCALE_SPREAD / 2 + random() * SCALE_SPREAD;
}

export type Disturbance = 'flicker' | 'jitter' | 'glitch';
/** The three shapes a glitch takes: a lagging copy, a colour split, a broken trail. */
export type GlitchShape = 'ghost' | 'split' | 'broken';

/** A disturbance is at least this short and at most this long. */
export const DISTURBANCE_MS: readonly [number, number] = [50, 150];
/** The calm between two disturbances: never shorter than this, then memoryless. */
const CALM_FLOOR_MS = 250;
const CALM_MEAN_MS = 900;
/** How often each kind comes, of all disturbances; a glitch is the rare one. */
const FLICKER_SHARE = 0.72;
const JITTER_SHARE = 0.25;

/**
 * How long a mote stays calm before its next disturbance. Exponential above a
 * floor, so the intervals never settle into a rhythm and two motes that left
 * together drift apart at once. With a mean of 1150 ms against 100 ms of
 * disturbance, a mote is calm about 92 percent of the time.
 */
export function calmMs(random: Random): number {
  return CALM_FLOOR_MS - CALM_MEAN_MS * Math.log(1 - random());
}

export function disturbanceKind(random: Random): Disturbance {
  const roll = random();
  if (roll < FLICKER_SHARE) return 'flicker';
  if (roll < FLICKER_SHARE + JITTER_SHARE) return 'jitter';
  return 'glitch';
}

export function disturbanceMs(random: Random): number {
  const [shortest, longest] = DISTURBANCE_MS;
  return shortest + random() * (longest - shortest);
}

export function glitchShape(random: Random): GlitchShape {
  const roll = random();
  if (roll < 0.4) return 'ghost';
  if (roll < 0.75) return 'split';
  return 'broken';
}

/**
 * How strong a flicker is: mostly a flash brighter than the mote, sometimes a
 * short dropout darker than it. The factor the brightness reaches at the peak.
 */
export function flickerPeak(random: Random): number {
  return random() < 0.75 ? 1.5 + random() * 0.7 : 0.3 + random() * 0.3;
}

/**
 * The brightness factor of a flicker at `progress` (0 to 1 through it): it
 * strikes fast and dies slower, like a spark rather than a sine, and a small
 * ripple on top keeps two flickers of equal peak from looking alike.
 */
export function flickerAt(progress: number, peak: number, ripple: number): number {
  const p = Math.min(1, Math.max(0, progress));
  const envelope = p < 0.2 ? p / 0.2 : Math.pow((1 - p) / 0.8, 1.6);
  const wobble = 1 + 0.25 * Math.sin((p * 3 + ripple) * Math.PI * 2);
  return 1 + (peak - 1) * envelope * wobble;
}

/**
 * The size factor that goes with a brightness factor: a flash swells the mote
 * a little, a dropout shrinks it a little, never as much as the light changes.
 */
export function flickerSize(brightness: number): number {
  return 1 + (brightness - 1) * 0.3;
}

/** How far a jittering mote may stray from its line, in world units: well inside its own glow. */
export const JITTER_REACH = 0.5;
/** How far the two halves of a split glitch stand apart from the mote, in world units. */
export const SPLIT_REACH = 0.8;
/** How far a ghost lags behind its mote, in seconds of its own travel. */
export const GHOST_LAG_S = 0.09;

/** The trail: this many fainter points behind the mote, each a little smaller. */
export const TRAIL_POINTS = 4;
/** The gap between two trail points in seconds of travel, so a faster mote draws a longer streak. */
export const TRAIL_STEP_S = 0.045;

/** How bright the trail point `index` (1 is next to the mote) is, relative to the mote. */
export function trailBrightness(index: number): number {
  return 0.55 * Math.pow(0.55, index - 1);
}

/** How large the trail point `index` is, relative to the mote. */
export function trailSize(index: number): number {
  return 1 - 0.14 * index;
}
