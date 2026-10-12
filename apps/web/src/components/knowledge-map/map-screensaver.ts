import { type KnowledgeMapEdgeKind } from '@exocortex/contracts';

import { endpointId, type MapGraph } from './map-model';

/**
 * The screensaver's imaginary colleagues (issue #189).
 *
 * Nothing here touches a page. A walker is a pattern of attention that looks
 * like real work on the map: each step names a point and whether it is read
 * or written, and the map lights it up exactly as it would for a run. The
 * patterns are the ones the live map actually shows, so the room looks busy in
 * the way it does when somebody is working in it:
 *
 * - `researcher` follows references and now and then starts over somewhere
 *   else, the way a search hit leads into a chain of links.
 * - `associative` follows similarity, the lines nobody drew.
 * - `librarian` walks the page tree depth first, down into a branch and back.
 * - `editor` reads around one page and then writes it, then moves next door.
 * - `wanderer` looks at a page anywhere, slowly.
 *
 * Pure, with the randomness handed in, so a test can replay a walk.
 */

export type WalkerStyle = 'researcher' | 'associative' | 'librarian' | 'editor' | 'wanderer';

export const WALKER_STYLES: readonly WalkerStyle[] = [
  'researcher',
  'associative',
  'librarian',
  'editor',
  'wanderer',
];

export interface Walker {
  style: WalkerStyle;
  /** Where it is now, or null before its first step and after its page vanished. */
  at: string | null;
  /** The pages it came through, most recent last; the librarian climbs back along it. */
  trail: string[];
  /** The editor's page: read around, then written. */
  anchor: string | null;
  /** How many steps the editor has read around its anchor. */
  around: number;
}

export interface Visit {
  nodeId: string;
  kind: 'read' | 'write';
}

/** The lines of each kind, both directions, and the page tree from `parentId`. */
export interface Neighbourhood {
  ids: readonly string[];
  byKind: Record<KnowledgeMapEdgeKind, ReadonlyMap<string, readonly string[]>>;
  children: ReadonlyMap<string, readonly string[]>;
  parent: ReadonlyMap<string, string>;
}

type Random = () => number;

const TRAIL_LENGTH = 24;
/** How often a researcher drops the chain and starts from a fresh hit. */
const RESTART = 0.15;
/** How many pages the editor reads before it writes. */
const READS_BEFORE_WRITE = 3;

/** How long each style waits between two steps, in milliseconds, as [least, most]. */
export const WALKER_TEMPO: Record<WalkerStyle, readonly [number, number]> = {
  researcher: [1_400, 3_600],
  associative: [2_400, 5_200],
  librarian: [1_000, 2_400],
  editor: [2_800, 6_000],
  wanderer: [5_000, 10_000],
};

/** How long the screensaver waits before it picks the next page to dwell on, as [least, most]. */
export const DWELL_MS: readonly [number, number] = [60_000, 300_000];

/**
 * The page the screensaver dwells on next, as if somebody had clicked it: one
 * with lines, so the neighbourhood that stays lit around it is worth seeing,
 * and never the one it is on now. Null when there is nothing else to pick.
 */
export function dwellTarget(
  around: Neighbourhood,
  current: string | null,
  random: () => number,
): string | null {
  const connected = around.ids.filter(
    (id) =>
      id !== current &&
      (around.children.has(id) ||
        around.parent.has(id) ||
        Object.values(around.byKind).some((lines) => lines.has(id))),
  );
  const pool = connected.length > 0 ? connected : around.ids.filter((id) => id !== current);
  return pool.length === 0 ? null : (pool[Math.floor(random() * pool.length)] ?? null);
}

export function neighbourhoodOf(graph: MapGraph): Neighbourhood {
  const byKind: Record<KnowledgeMapEdgeKind, Map<string, string[]>> = {
    link: new Map(),
    similar: new Map(),
    entity: new Map(),
    tree: new Map(),
  };
  const add = (map: Map<string, string[]>, from: string, to: string): void => {
    const list = map.get(from);
    if (list === undefined) map.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  };
  for (const link of graph.links) {
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    add(byKind[link.kind], source, target);
    add(byKind[link.kind], target, source);
  }
  const known = new Set(graph.nodes.map((node) => node.id));
  const children = new Map<string, string[]>();
  const parent = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.parentId === null || !known.has(node.parentId)) continue;
    parent.set(node.id, node.parentId);
    add(children, node.parentId, node.id);
  }
  return { ids: [...known], byKind, children, parent };
}

export function newWalker(style: WalkerStyle): Walker {
  return { style, at: null, trail: [], anchor: null, around: 0 };
}

/** The pause before a walker's next step. */
export function nextDelay(style: WalkerStyle, random: Random): number {
  const [least, most] = WALKER_TEMPO[style];
  return least + random() * (most - least);
}

function pick<T>(list: readonly T[], random: Random): T | undefined {
  return list.length === 0 ? undefined : list[Math.floor(random() * list.length)];
}

function neighboursOf(
  around: Neighbourhood,
  nodeId: string,
  kinds: readonly KnowledgeMapEdgeKind[],
): string[] {
  return kinds.flatMap((kind) => around.byKind[kind].get(nodeId) ?? []);
}

/** Prefers a neighbour not visited lately, so a walk moves on instead of pacing. */
function freshNeighbour(
  around: Neighbourhood,
  walker: Walker,
  kinds: readonly KnowledgeMapEdgeKind[],
  random: Random,
): string | undefined {
  if (walker.at === null) return undefined;
  const all = neighboursOf(around, walker.at, kinds);
  const fresh = all.filter((id) => !walker.trail.includes(id));
  return pick(fresh.length > 0 ? fresh : all, random);
}

function moved(walker: Walker, nodeId: string, extra: Partial<Walker> = {}): Walker {
  const trail = [...walker.trail, nodeId].slice(-TRAIL_LENGTH);
  return { ...walker, ...extra, at: nodeId, trail };
}

type Step = { walker: Walker; visit: Visit };
type Anywhere = () => string;

function wanderer(current: Walker, anywhere: Anywhere): Step {
  const next = anywhere();
  return { walker: moved(current, next), visit: { nodeId: next, kind: 'read' } };
}

/** Researcher and associative walker: a chain along one kind of line, restarted now and then. */
function chain(current: Walker, around: Neighbourhood, random: Random, anywhere: Anywhere): Step {
  const researcher = current.style === 'researcher';
  const kinds: KnowledgeMapEdgeKind[] = researcher ? ['link', 'entity'] : ['similar', 'link'];
  const restart = current.at === null || random() < RESTART;
  const next = (restart ? undefined : freshNeighbour(around, current, kinds, random)) ?? anywhere();
  const writes = random() < (researcher ? 0.06 : 0.04);
  return { walker: moved(current, next), visit: { nodeId: next, kind: writes ? 'write' : 'read' } };
}

function rootOf(around: Neighbourhood, nodeId: string): string {
  let root = nodeId;
  let parent = around.parent.get(root);
  while (parent !== undefined) {
    root = parent;
    parent = around.parent.get(root);
  }
  return root;
}

function librarian(
  current: Walker,
  around: Neighbourhood,
  random: Random,
  anywhere: Anywhere,
): Step {
  if (current.at === null) {
    // A branch is entered from the top: the root of wherever it lands.
    const root = rootOf(around, anywhere());
    return { walker: moved(current, root), visit: { nodeId: root, kind: 'read' } };
  }
  const unread = (around.children.get(current.at) ?? []).filter(
    (id) => !current.trail.includes(id),
  );
  const down = pick(unread, random);
  const next = down ?? around.parent.get(current.at) ?? anywhere();
  // Back at a root with every branch read: start over elsewhere with a fresh memory.
  const done = down === undefined && !around.parent.has(current.at);
  const walker = done ? { ...moved(current, next), trail: [next] } : moved(current, next);
  return { walker, visit: { nodeId: next, kind: random() < 0.05 ? 'write' : 'read' } };
}

function editor(current: Walker, around: Neighbourhood, random: Random, anywhere: Anywhere): Step {
  const kept = current.anchor !== null && around.ids.includes(current.anchor);
  const anchor = kept && current.anchor !== null ? current.anchor : anywhere();
  if (!kept || current.at === null) {
    return {
      walker: moved(current, anchor, { anchor, around: 0 }),
      visit: { nodeId: anchor, kind: 'read' },
    };
  }
  if (current.around >= READS_BEFORE_WRITE) {
    // Written; the next page to work on is one of the pages just read.
    const nextAnchor = pick(current.trail.slice(-READS_BEFORE_WRITE), random) ?? anchor;
    return {
      walker: moved(current, anchor, { anchor: nextAnchor, around: 0 }),
      visit: { nodeId: anchor, kind: 'write' },
    };
  }
  const next =
    pick(neighboursOf(around, anchor, ['link', 'similar', 'tree', 'entity']), random) ?? anywhere();
  return {
    walker: moved(current, next, { around: current.around + 1 }),
    visit: { nodeId: next, kind: 'read' },
  };
}

/**
 * One step of a walker: where it goes and what it does there. Null when the
 * map has no page at all. A walker standing on a page that is gone starts
 * again somewhere.
 */
export function stepWalker(walker: Walker, around: Neighbourhood, random: Random): Step | null {
  if (around.ids.length === 0) return null;
  const current =
    walker.at !== null && around.ids.includes(walker.at) ? walker : { ...walker, at: null };
  const anywhere = (): string => pick(around.ids, random) ?? around.ids[0] ?? '';
  switch (current.style) {
    case 'wanderer':
      return wanderer(current, anywhere);
    case 'researcher':
    case 'associative':
      return chain(current, around, random, anywhere);
    case 'librarian':
      return librarian(current, around, random, anywhere);
    case 'editor':
      return editor(current, around, random, anywhere);
  }
}
