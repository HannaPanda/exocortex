import {
  type KnowledgeMapEdgeKind,
  type KnowledgeMapNode,
  type KnowledgeMapResponse,
} from '@exocortex/contracts';

/**
 * The knowledge map's model, without a canvas (issue #189).
 *
 * Everything here is pure so it can be tested: how a fresh answer from the API
 * is merged into the graph on screen without the points jumping, how long a
 * flash of light lasts, which points are there at a given moment of the
 * timeline, and which ones carry a label.
 */

/**
 * A point as the graph library holds it. The library writes the position
 * (`x`, `y`, `z`) and the velocity onto the object itself, which is why a
 * merge keeps the old object: a new one would start at the origin again and
 * the whole cloud would explode on every update.
 */
export interface MapNode extends KnowledgeMapNode {
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
}

/**
 * A line as the graph library holds it. The library replaces `source` and
 * `target` with the node objects once it has seen the line, so both spellings
 * occur and `endpointId` reads either.
 */
export interface MapLink {
  key: string;
  source: string | MapNode;
  target: string | MapNode;
  kind: KnowledgeMapEdgeKind;
  weight: number;
}

export interface MapGraph {
  nodes: MapNode[];
  links: MapLink[];
}

export function endpointId(end: string | MapNode): string {
  return typeof end === 'string' ? end : end.id;
}

export function linkKey(source: string, target: string, kind: KnowledgeMapEdgeKind): string {
  return `${kind}:${source}|${target}`;
}

export interface MergeResult {
  graph: MapGraph;
  /** Points that were not there before. Empty on the first load. */
  addedNodes: string[];
  /** Lines that were not there before. Empty on the first load. */
  addedLinks: string[];
}

/**
 * Brings the graph on screen to a fresh answer. Points and lines that are in
 * both keep their objects (and with them their position); new ones are added,
 * missing ones dropped. What is new is reported, so the map can let it flash.
 */
export function mergeGraph(previous: MapGraph | null, next: KnowledgeMapResponse): MergeResult {
  const oldNodes = new Map((previous?.nodes ?? []).map((node) => [node.id, node]));
  const oldLinks = new Map((previous?.links ?? []).map((link) => [link.key, link]));
  const addedNodes: string[] = [];
  const addedLinks: string[] = [];

  const nodes = next.nodes.map((fresh): MapNode => {
    const kept = oldNodes.get(fresh.id);
    if (kept === undefined) {
      if (previous !== null) addedNodes.push(fresh.id);
      return { ...fresh };
    }
    // Same object, fresh facts: a renamed page keeps its place in the room.
    return Object.assign(kept, fresh);
  });

  const links = next.edges.map((edge): MapLink => {
    const key = linkKey(edge.source, edge.target, edge.kind);
    const kept = oldLinks.get(key);
    if (kept !== undefined) {
      kept.weight = edge.weight;
      return kept;
    }
    if (previous !== null) addedLinks.push(key);
    return { key, source: edge.source, target: edge.target, kind: edge.kind, weight: edge.weight };
  });

  return { graph: { nodes, links }, addedNodes, addedLinks };
}

/** Why a point is lit. */
export type PulseKind = 'read' | 'write' | 'created' | 'removed';

/**
 * How long each kind of light takes to fade. A read is the briefest, because
 * a run reads in bursts and a long glow would light the whole map; a new page
 * stays longest, because it is the one thing somebody watching wants to find.
 * A lit point also carries its title, so the light lasts long enough to read
 * the name it stands for.
 */
export const PULSE_MS: Record<PulseKind, number> = {
  read: 3_900,
  write: 7_500,
  created: 12_000,
  removed: 3_000,
};

export interface Pulse {
  kind: PulseKind;
  at: number;
}

/** How long a pulse takes to come up, eased out cubically. */
export const PULSE_FADE_IN_MS = 170;
/** How long it takes to die down at the end, eased in and out along a sine. */
export const PULSE_FADE_OUT_MS = 880;

/** Whether a pulse has run its course; a fresh one at strength 0 has not. */
export function pulseOver(pulse: Pulse, now: number): boolean {
  return now - pulse.at >= PULSE_MS[pulse.kind];
}

/**
 * How bright a pulse is, from 0 to 1. It comes up quickly but not at once,
 * holds while its name can be read, and glimmers out softly: an instant
 * switch to full read as a flicker, a long decay as a page still busy. The
 * curves were picked side by side against the alternatives.
 */
export function pulseStrength(pulse: Pulse, now: number): number {
  const elapsed = now - pulse.at;
  const duration = PULSE_MS[pulse.kind];
  if (elapsed <= 0 || elapsed >= duration) return 0;
  if (elapsed < PULSE_FADE_IN_MS) return 1 - Math.pow(1 - elapsed / PULSE_FADE_IN_MS, 3);
  const fadeStart = duration - PULSE_FADE_OUT_MS;
  if (elapsed <= fadeStart) return 1;
  // 1 minus easeInOutSine of the fade's progress.
  return (Math.cos((Math.PI * (elapsed - fadeStart)) / PULSE_FADE_OUT_MS) + 1) / 2;
}

/**
 * Whether a new pulse may replace the one a point already carries. A write
 * outranks a read: a run that reads a page right after writing it must not
 * dim the amber that says it was just changed.
 */
export function supersedes(next: Pulse, current: Pulse | undefined, now: number): boolean {
  if (current === undefined || pulseOver(current, now)) return true;
  const rank: Record<PulseKind, number> = { read: 0, created: 1, write: 2, removed: 3 };
  return rank[next.kind] >= rank[current.kind];
}

/** `document:<id>` from a tool call's subject, the id alone; anything else is nothing. */
export function documentIdOfSubject(subject: string | null | undefined): string | null {
  if (typeof subject !== 'string' || !subject.startsWith('document:')) return null;
  const id = subject.slice('document:'.length);
  return id.length > 0 ? id : null;
}

/** The first and the last moment of the timeline: the oldest page and now. */
export function timelineBounds(nodes: readonly KnowledgeMapNode[], now: number): [number, number] {
  let first = now;
  for (const node of nodes) {
    const created = Date.parse(node.createdAt);
    if (Number.isFinite(created) && created < first) first = created;
  }
  return [first, now];
}

/** Whether a point already existed at a moment of the timeline; `null` is "now". */
export function existsAt(node: KnowledgeMapNode, moment: number | null): boolean {
  if (moment === null) return true;
  const created = Date.parse(node.createdAt);
  return !Number.isFinite(created) || created <= moment;
}

/**
 * Which colour each branch wears: the biggest branches first, so the regions
 * a reader sees most are the ones that are told apart best. Branches past the
 * palette share the last colours, which is the honest answer to having more
 * top-level pages than distinguishable hues.
 */
export function branchColourIndex(
  nodes: readonly KnowledgeMapNode[],
  paletteSize: number,
): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const node of nodes) sizes.set(node.rootId, (sizes.get(node.rootId) ?? 0) + 1);
  const order = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const index = new Map<string, number>();
  order.forEach(([rootId], position) => {
    index.set(rootId, Math.min(position, paletteSize - 1));
  });
  return index;
}

/** The direct neighbours of a point, through lines of the kinds shown. */
export function neighboursOf(
  graph: MapGraph,
  nodeId: string,
  shown: ReadonlySet<KnowledgeMapEdgeKind>,
): Set<string> {
  const around = new Set<string>();
  for (const link of graph.links) {
    if (!shown.has(link.kind)) continue;
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    if (source === nodeId) around.add(target);
    else if (target === nodeId) around.add(source);
  }
  return around;
}

/**
 * The stops of a tour through search results: the hits the map knows, best
 * first, at most `limit`. A hit in the trash or in another workspace is not on
 * the map and is skipped rather than flown to.
 */
export function tourStops(
  hitIds: readonly string[],
  known: ReadonlySet<string>,
  limit: number,
): string[] {
  const stops: string[] = [];
  for (const id of hitIds) {
    if (!known.has(id) || stops.includes(id)) continue;
    stops.push(id);
    if (stops.length === limit) break;
  }
  return stops;
}

/** How many lines meet at each point, the tree included because it pulls too. */
export function linkDegrees(links: readonly MapLink[]): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const link of links) {
    for (const end of [endpointId(link.source), endpointId(link.target)]) {
      degrees.set(end, (degrees.get(end) ?? 0) + 1);
    }
  }
  return degrees;
}

/**
 * How hard one line pulls, given how hard its kind pulls and how many lines
 * meet at its two ends. d3's own rule: the busier end decides nothing, the
 * quieter one shares its pull among its lines. Without it a branch where every
 * page links to every sibling collapsed into a knot while a sparse branch
 * stayed wide, because each of a dozen lines pulled as hard as a single one.
 */
export function sharedPull(kindPull: number, sourceDegree: number, targetDegree: number): number {
  const quieter = Math.max(1, Math.min(sourceDegree, targetDegree));
  return Math.min(kindPull, (kindPull * 2) / quieter);
}
