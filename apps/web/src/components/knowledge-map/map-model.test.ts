import { describe, expect, it } from 'vitest';

import { type KnowledgeMapNode, type KnowledgeMapResponse } from '@exocortex/contracts';

import {
  branchColourIndex,
  documentIdOfSubject,
  existsAt,
  linkDegrees,
  mergeGraph,
  neighboursOf,
  pulseStrength,
  sharedPull,
  supersedes,
  timelineBounds,
  tourStops,
} from './map-model';

function node(id: string, extra: Partial<KnowledgeMapNode> = {}): KnowledgeMapNode {
  return {
    id,
    kind: 'page',
    title: id,
    type: 'PAGE',
    icon: null,
    iconColor: null,
    parentId: null,
    rootId: id,
    degree: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    editedAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

function answer(
  nodes: KnowledgeMapNode[],
  edges: KnowledgeMapResponse['edges'],
): KnowledgeMapResponse {
  return {
    workspaceId: 'ws1234567890',
    generatedAt: '2026-10-12T00:00:00.000Z',
    semantic: 'ok',
    nodes,
    edges,
  };
}

describe('mergeGraph', () => {
  const first = answer(
    [node('aaaaaaaaaa'), node('bbbbbbbbbb')],
    [{ source: 'aaaaaaaaaa', target: 'bbbbbbbbbb', kind: 'link', weight: 0.5 }],
  );

  it('reports nothing as new on the first load, so the map does not light up entirely', () => {
    const merged = mergeGraph(null, first);
    expect(merged.graph.nodes).toHaveLength(2);
    expect(merged.addedNodes).toEqual([]);
    expect(merged.addedLinks).toEqual([]);
  });

  it('keeps the objects of points that stay, so they keep their place in the room', () => {
    const { graph } = mergeGraph(null, first);
    const a = graph.nodes[0];
    if (a === undefined) throw new Error('missing node');
    Object.assign(a, { x: 10, y: 20, z: 30 });

    const renamed = answer(
      [node('aaaaaaaaaa', { title: 'Umbenannt' }), node('cccccccccc')],
      [{ source: 'aaaaaaaaaa', target: 'cccccccccc', kind: 'similar', weight: 0.9 }],
    );
    const merged = mergeGraph(graph, renamed);
    expect(merged.graph.nodes[0]).toBe(a);
    expect(merged.graph.nodes[0]).toMatchObject({ title: 'Umbenannt', x: 10, z: 30 });
    expect(merged.addedNodes).toEqual(['cccccccccc']);
    expect(merged.addedLinks).toEqual(['similar:aaaaaaaaaa|cccccccccc']);
    expect(merged.graph.nodes.map((entry) => entry.id)).not.toContain('bbbbbbbbbb');
  });
});

describe('pulses', () => {
  it('starts at full strength and is gone after its duration', () => {
    expect(pulseStrength({ kind: 'read', at: 1000 }, 1000)).toBe(1);
    expect(pulseStrength({ kind: 'read', at: 1000 }, 2000)).toBeGreaterThan(0);
    expect(pulseStrength({ kind: 'read', at: 1000 }, 1000 + 3900)).toBe(0);
  });

  it('lets a write outrank a read, and anything replace a pulse that is over', () => {
    const write = { kind: 'write' as const, at: 0 };
    expect(supersedes({ kind: 'read', at: 100 }, write, 100)).toBe(false);
    expect(supersedes({ kind: 'write', at: 100 }, { kind: 'read', at: 0 }, 100)).toBe(true);
    expect(supersedes({ kind: 'read', at: 9000 }, write, 9000)).toBe(true);
  });

  it('reads the page out of a tool call subject and nothing else', () => {
    expect(documentIdOfSubject('document:abc123')).toBe('abc123');
    expect(documentIdOfSubject('workspace:abc123')).toBeNull();
    expect(documentIdOfSubject(null)).toBeNull();
  });
});

describe('timeline', () => {
  const nodes = [
    node('old0000000', { createdAt: '2026-08-01T00:00:00.000Z' }),
    node('new0000000', { createdAt: '2026-10-01T00:00:00.000Z' }),
  ];

  it('runs from the oldest page to now', () => {
    const now = Date.parse('2026-10-12T00:00:00.000Z');
    expect(timelineBounds(nodes, now)).toEqual([Date.parse('2026-08-01T00:00:00.000Z'), now]);
  });

  it('shows a page only from the moment it was created', () => {
    const september = Date.parse('2026-09-01T00:00:00.000Z');
    expect(nodes.filter((entry) => existsAt(entry, september)).map((entry) => entry.id)).toEqual([
      'old0000000',
    ]);
    expect(nodes.every((entry) => existsAt(entry, null))).toBe(true);
  });
});

describe('labels, colours, neighbours and tours', () => {
  const nodes = [
    node('hub0000000', { degree: 9 }),
    node('mid0000000', { degree: 3, rootId: 'hub0000000' }),
    node('alone00000', { degree: 0 }),
  ];

  it('gives the biggest branch the first colour and clamps to the palette', () => {
    const index = branchColourIndex(nodes, 1);
    expect(index.get('hub0000000')).toBe(0);
    expect(index.get('alone00000')).toBe(0);
    expect(branchColourIndex(nodes, 9).get('alone00000')).toBe(1);
  });

  it('finds neighbours only through the kinds of line that are shown', () => {
    const { graph } = mergeGraph(
      null,
      answer(nodes, [
        { source: 'hub0000000', target: 'mid0000000', kind: 'tree', weight: 1 },
        { source: 'alone00000', target: 'hub0000000', kind: 'similar', weight: 0.7 },
      ]),
    );
    expect([...neighboursOf(graph, 'hub0000000', new Set(['similar']))]).toEqual(['alone00000']);
  });

  it('tours the hits the map knows, best first, without repeats', () => {
    const known = new Set(['a', 'b', 'c']);
    expect(tourStops(['x', 'b', 'b', 'a', 'c'], known, 2)).toEqual(['b', 'a']);
  });
});

describe('linkDegrees', () => {
  it('counts both ends of every line, whichever spelling the library left', () => {
    const a = { ...node('a') };
    const degrees = linkDegrees([
      { key: '1', source: a, target: 'b', kind: 'link', weight: 1 },
      { key: '2', source: 'a', target: 'c', kind: 'tree', weight: 1 },
    ]);
    expect(degrees.get('a')).toBe(2);
    expect(degrees.get('b')).toBe(1);
    expect(degrees.get('c')).toBe(1);
  });
});

describe('sharedPull', () => {
  it('leaves a sparse line at its full pull', () => {
    expect(sharedPull(0.6, 1, 2)).toBe(0.6);
    expect(sharedPull(0.6, 2, 30)).toBe(0.6);
  });

  it('shares the pull among the lines of the quieter end', () => {
    expect(sharedPull(0.6, 12, 8)).toBeCloseTo(0.15);
  });
});
