import { type KnowledgeMapEdgeKind } from '@exocortex/contracts';

import { endpointId, type MapLink, type MapNode, type PulseKind } from './map-model';

/**
 * The traffic on the map's lines (issue #189): when a mote leaves, which way it
 * travels and how fast, decided from what the map actually knows.
 *
 * The library's own particles moved a fixed share of their line per frame, so
 * everything sent at once arrived at once, and every line carried the same
 * evenly spaced bead. Here a mote has a speed in world units, so a near
 * neighbour hears first and a far one later; a pulse leaves its lines one
 * after another, most important first; a read flows in and a write flows out;
 * and a line between pages somebody is working on is busier than one between
 * pages nobody has touched in months.
 *
 * Pure, with the randomness and the clock handed in, so a test can replay it.
 */

type Random = () => number;

/** The kinds of line in the order a pulse uses them: references first, the tree last. */
const KIND_RANK: Record<KnowledgeMapEdgeKind, number> = {
  link: 3,
  similar: 2,
  entity: 1.5,
  tree: 1,
};

/** World units per second on the slowest lane; the strongest lines are about three times as fast. */
const LANE_BASE = 16;
const LANE_GAIN = 34;
/** Every mote drives a little faster or slower than its lane, so a convoy stretches. */
const LANE_SPREAD = 0.3;

/**
 * How fast a mote travels this line. The weight is the lane: a reference made
 * often or a close similarity is the motorway, a faint one the country road.
 * The tree and entity mentions have no weight of their own and take a slow lane.
 */
export function laneSpeed(link: MapLink, random: Random): number {
  const weight = link.kind === 'tree' || link.kind === 'entity' ? 0.2 : link.weight;
  return (LANE_BASE + weight * LANE_GAIN) * (1 - LANE_SPREAD / 2 + random() * LANE_SPREAD);
}

/** How long a burst takes to leave all of a point's lines, before the jitter. */
export const BURST_SPREAD_MS = 900;
/** The jitter on each departure, so two lines of equal rank do not leave together. */
const BURST_JITTER_MS = 140;
/** A point with a hundred lines sends on its strongest ones only. */
export const BURST_LIMIT = 40;

export interface Departure {
  link: MapLink;
  /** True when the mote travels from `source` to `target`. */
  forward: boolean;
  /** Milliseconds after the pulse. */
  delay: number;
}

/**
 * Which way light travels when a point is used: a read gathers from the
 * neighbours, so it flows in; a write, a new page and a removal spread out.
 */
export function flowsInward(kind: PulseKind): boolean {
  return kind === 'read';
}

function importance(link: MapLink): number {
  return KIND_RANK[link.kind] + link.weight;
}

/**
 * The motes a pulse sends: one per line of the point, the most important line
 * first and the weakest last, spread over `BURST_SPREAD_MS` with a little
 * jitter, each pointing in or out by the kind of access.
 */
export function burstPlan(
  nodeId: string,
  kind: PulseKind,
  links: readonly MapLink[],
  random: Random,
): Departure[] {
  const inward = flowsInward(kind);
  const touching = links
    .filter((link) => endpointId(link.source) === nodeId || endpointId(link.target) === nodeId)
    .sort((a, b) => importance(b) - importance(a))
    .slice(0, BURST_LIMIT);
  const last = Math.max(1, touching.length - 1);
  return touching.map((link, rank) => {
    const fromHere = endpointId(link.source) === nodeId;
    return {
      link,
      // Out of the point means leaving from its end of the line; in means arriving there.
      forward: inward ? !fromHere : fromHere,
      delay:
        (touching.length > 1 ? (rank / last) * BURST_SPREAD_MS : 0) + random() * BURST_JITTER_MS,
    };
  });
}

/** After this long without a change a page counts as half asleep. */
const FRESHNESS_HALF_LIFE_DAYS = 14;
const DAY_MS = 86_400_000;

/** How lively a page is, from 1 (changed just now) towards 0 (untouched for months). */
export function freshness(node: Pick<MapNode, 'editedAt'>, now: number): number {
  const edited = Date.parse(node.editedAt);
  if (Number.isNaN(edited)) return 0;
  const days = Math.max(0, now - edited) / DAY_MS;
  return Math.pow(0.5, days / FRESHNESS_HALF_LIFE_DAYS);
}

export type TrafficState = 'normal' | 'dim' | 'lit';

/** Motes per second on a quiet line of each kind, before liveliness. */
const IDLE_RATE: Record<KnowledgeMapEdgeKind, number> = {
  link: 0.16,
  similar: 0.1,
  entity: 0,
  tree: 0,
};
/** Motes per second on the lines of the selected point, whatever their kind. */
const LIT_RATE = 0.9;

/**
 * How many motes a line sends per second while nothing happens. A reference
 * carries traffic, a similarity only when it is close, the tree and entity
 * mentions none; and how much depends on the livelier of its two pages, so the
 * part of the map somebody works in hums and an archive is quiet but not dead.
 * The lines of a selected point are busy, the dimmed ones nearly silent.
 */
export function idleRate(link: MapLink, liveliness: number, state: TrafficState): number {
  if (state === 'lit') return LIT_RATE * (0.5 + liveliness);
  if (link.kind === 'similar' && link.weight <= 0.5) return 0;
  const rate = IDLE_RATE[link.kind] * (0.2 + 1.6 * liveliness);
  return state === 'dim' ? rate * 0.25 : rate;
}

/**
 * How many motes travel together when a line sends: mostly one, now and then a
 * short convoy, which is what turns a string of beads into traffic.
 */
export function convoySize(random: Random): number {
  const roll = random();
  if (roll < 0.08) return 3;
  if (roll < 0.3) return 2;
  return 1;
}

/** The gap between two motes of one convoy, in milliseconds. */
export function convoyGap(random: Random): number {
  return 130 + random() * 170;
}

/**
 * Which way an idle mote travels: along a reference from the page that makes
 * it to the page it names, either way on the lines that have no direction.
 */
export function idleForward(link: MapLink, random: Random): boolean {
  return link.kind === 'link' || random() < 0.5;
}

/** How bright a mote is at `t` along its line: it fades in when it leaves and out as it arrives. */
export function moteBrightness(t: number): number {
  const edge = 0.1;
  if (t < edge) return t / edge;
  if (t > 1 - edge) return (1 - t) / edge;
  return 1;
}
