import { describe, expect, it } from 'vitest';

import { buildTree, collectAncestors, collectDescendantIds, wouldCreateCycle } from './tree';

const nodes = [
  { id: 'root-b', parentId: null, orderKey: 'b' },
  { id: 'root-a', parentId: null, orderKey: 'a' },
  { id: 'child-a2', parentId: 'root-a', orderKey: 'n' },
  { id: 'child-a1', parentId: 'root-a', orderKey: 'c' },
  { id: 'grandchild', parentId: 'child-a1', orderKey: 'V' },
];

describe('buildTree', () => {
  it('nests children and orders siblings by orderKey', () => {
    const tree = buildTree(nodes);
    expect(tree.map((entry) => entry.node.id)).toEqual(['root-a', 'root-b']);
    expect(tree[0]!.children.map((entry) => entry.node.id)).toEqual(['child-a1', 'child-a2']);
    expect(tree[0]!.children[0]!.children.map((entry) => entry.node.id)).toEqual(['grandchild']);
  });

  it('treats orphans as roots instead of dropping them', () => {
    const tree = buildTree([{ id: 'orphan', parentId: 'missing', orderKey: 'V' }]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.node.id).toBe('orphan');
  });

  it('breaks orderKey ties deterministically by id', () => {
    const tree = buildTree([
      { id: 'b', parentId: null, orderKey: 'V' },
      { id: 'a', parentId: null, orderKey: 'V' },
    ]);
    expect(tree.map((entry) => entry.node.id)).toEqual(['a', 'b']);
  });
});

describe('collectDescendantIds', () => {
  it('collects the full subtree', () => {
    expect([...collectDescendantIds(nodes, 'root-a')].sort()).toEqual([
      'child-a1',
      'child-a2',
      'grandchild',
    ]);
  });

  it('returns an empty set for leaves', () => {
    expect(collectDescendantIds(nodes, 'grandchild').size).toBe(0);
  });
});

describe('wouldCreateCycle', () => {
  it('rejects moving a document into itself', () => {
    expect(wouldCreateCycle(nodes, 'root-a', 'root-a')).toBe(true);
  });

  it('rejects moving a document into its own descendant', () => {
    expect(wouldCreateCycle(nodes, 'root-a', 'grandchild')).toBe(true);
  });

  it('allows moving to an unrelated parent', () => {
    expect(wouldCreateCycle(nodes, 'child-a1', 'root-b')).toBe(false);
  });

  it('allows moving to the root', () => {
    expect(wouldCreateCycle(nodes, 'grandchild', null)).toBe(false);
  });
});

describe('collectAncestors', () => {
  it('returns the chain from root to parent', () => {
    expect(collectAncestors(nodes, 'grandchild').map((node) => node.id)).toEqual([
      'root-a',
      'child-a1',
    ]);
  });

  it('returns an empty chain for a root document', () => {
    expect(collectAncestors(nodes, 'root-a')).toEqual([]);
  });

  it('does not hang on corrupt cyclic data', () => {
    const cyclic = [
      { id: 'a', parentId: 'b', orderKey: 'V' },
      { id: 'b', parentId: 'a', orderKey: 'V' },
    ];
    expect(collectAncestors(cyclic, 'a').length).toBeLessThanOrEqual(2);
  });
});
