import { describe, expect, it } from 'vitest';

import { type KnowledgeMapEdgeKind, type KnowledgeMapNode } from '@exocortex/contracts';

import { type MapGraph } from './map-model';
import {
  dwellTarget,
  type Neighbourhood,
  neighbourhoodOf,
  newWalker,
  nextDelay,
  stepWalker,
  type Visit,
  type Walker,
  WALKER_TEMPO,
} from './map-screensaver';

function node(id: string, parentId: string | null = null): KnowledgeMapNode {
  return {
    id,
    kind: 'page',
    title: id,
    type: 'PAGE',
    icon: null,
    iconColor: null,
    parentId,
    rootId: id,
    degree: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    editedAt: '2026-10-01T00:00:00.000Z',
  };
}

function line(source: string, target: string, kind: KnowledgeMapEdgeKind) {
  return { key: `${kind}:${source}|${target}`, source, target, kind, weight: 1 };
}

/** A tree root > a, b; a > a1, a2; references a1 -> b, similarity a2 ~ b. */
const graph: MapGraph = {
  nodes: [
    node('root'),
    node('a', 'root'),
    node('b', 'root'),
    node('a1', 'a'),
    node('a2', 'a'),
    node('lone'),
  ],
  links: [line('a1', 'b', 'link'), line('a2', 'b', 'similar')],
};

/** A fixed sequence of "random" numbers, repeated. */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length] ?? 0;
}

function walk(walker: Walker, around: Neighbourhood, steps: number, random: () => number) {
  const visits: Visit[] = [];
  let current = walker;
  for (let step = 0; step < steps; step += 1) {
    const next = stepWalker(current, around, random);
    if (next === null) break;
    visits.push(next.visit);
    current = next.walker;
  }
  return { visits, walker: current };
}

describe('neighbourhoodOf', () => {
  it('knows every line both ways and the tree from parentId', () => {
    const around = neighbourhoodOf(graph);
    expect(around.byKind.link.get('b')).toEqual(['a1']);
    expect(around.byKind.similar.get('a2')).toEqual(['b']);
    expect(around.children.get('a')).toEqual(['a1', 'a2']);
    expect(around.parent.get('a1')).toBe('a');
  });
});

describe('stepWalker', () => {
  const around = neighbourhoodOf(graph);

  it('answers nothing on an empty map', () => {
    const empty = neighbourhoodOf({ nodes: [], links: [] });
    expect(stepWalker(newWalker('wanderer'), empty, Math.random)).toBeNull();
  });

  it('lets a researcher follow references', () => {
    const start = { ...newWalker('researcher'), at: 'a1', trail: ['a1'] };
    // 0.5: no restart, then picks the only reference, then reads.
    const step = stepWalker(start, around, sequence(0.5));
    expect(step?.visit).toEqual({ nodeId: 'b', kind: 'read' });
  });

  it('lets an associative walker follow similarity', () => {
    const start = { ...newWalker('associative'), at: 'a2', trail: ['a2'] };
    expect(stepWalker(start, around, sequence(0.5))?.visit.nodeId).toBe('b');
  });

  it('walks a branch of the tree from its root, down and back up', () => {
    const { visits } = walk(newWalker('librarian'), around, 5, sequence(0.1));
    expect(visits.map((visit) => visit.nodeId)).toEqual(['root', 'a', 'a1', 'a', 'a2']);
  });

  it('lets an editor read around a page and then write it', () => {
    const { visits } = walk(newWalker('editor'), around, 5, sequence(0.5));
    const anchor = visits[0]?.nodeId;
    expect(visits.slice(0, 4).every((visit) => visit.kind === 'read')).toBe(true);
    expect(visits[4]).toEqual({ nodeId: anchor, kind: 'write' });
  });

  it('starts again when its page has vanished', () => {
    const lost = { ...newWalker('researcher'), at: 'gone', trail: ['gone'] };
    const step = stepWalker(lost, around, sequence(0.5));
    expect(around.ids).toContain(step?.visit.nodeId);
  });
});

describe('nextDelay', () => {
  it('stays inside the style tempo', () => {
    const [least, most] = WALKER_TEMPO.wanderer;
    expect(nextDelay('wanderer', () => 0)).toBe(least);
    expect(nextDelay('wanderer', () => 1)).toBe(most);
  });
});

describe('dwellTarget', () => {
  const around = neighbourhoodOf(graph);

  it('picks a connected page, never the lone one or the current one', () => {
    const picked = new Set(
      [0, 0.2, 0.4, 0.6, 0.8, 0.99].map((value) => dwellTarget(around, 'root', () => value)),
    );
    expect(picked.has('lone')).toBe(false);
    expect(picked.has('root')).toBe(false);
    expect(picked.size).toBeGreaterThan(1);
  });

  it('answers nothing when there is no other page', () => {
    const single = neighbourhoodOf({ nodes: graph.nodes.slice(0, 1), links: [] });
    expect(dwellTarget(single, 'root', () => 0.5)).toBeNull();
  });
});
