import { describe, expect, it } from 'vitest';

import { type DocumentTreeNode } from '@exocortex/contracts';

import { treeBranch } from '@/test-support/document-tree';

import { ancestorsOf, indexTree, isSelfOrDescendant, parseExpanded } from './page-tree-state';

const tree: DocumentTreeNode[] = [
  treeBranch('a', null, [treeBranch('a1', 'a', [treeBranch('a1x', 'a1')]), treeBranch('a2', 'a')]),
  treeBranch('b', null),
];

const first = tree[0] as DocumentTreeNode;

describe('parseExpanded', () => {
  it('keeps only the ids that are unfolded', () => {
    expect(parseExpanded('{"a":true,"b":false,"c":true}')).toEqual({ a: true, c: true });
  });

  it('discards anything that is not an object of booleans', () => {
    expect(parseExpanded('["a","b"]')).toEqual({});
    expect(parseExpanded('null')).toEqual({});
    expect(parseExpanded('"a"')).toEqual({});
  });

  it('drops truthy non-booleans instead of repairing them', () => {
    // A stored `1` is something this app never wrote, so it is evidence of a
    // corrupt entry rather than a shorthand for `true`.
    expect(parseExpanded('{"a":1,"b":"true"}')).toEqual({});
  });
});

describe('ancestorsOf', () => {
  it('returns the chain above a nested page, root first', () => {
    expect(ancestorsOf(tree, 'a1x')).toEqual(['a', 'a1']);
  });

  it('returns an empty chain for a root page', () => {
    expect(ancestorsOf(tree, 'b')).toEqual([]);
  });

  it('separates "no ancestors" from "not in this tree"', () => {
    // The sidebar waits on `null` and acts on `[]`; collapsing the two would
    // make a root page look like a tree that has not finished loading.
    expect(ancestorsOf(tree, 'nope')).toBeNull();
  });
});

describe('indexTree', () => {
  it('records the parent, the siblings and the position of every row', () => {
    const positions = indexTree(tree);

    expect(positions.size).toBe(5);
    expect(positions.get('a2')).toMatchObject({ parentId: 'a', index: 1 });
    expect(positions.get('a2')?.siblings.map((entry) => entry.id)).toEqual(['a1', 'a2']);
    expect(positions.get('b')).toMatchObject({ parentId: null, index: 1 });
  });

  it('knows nothing about a row that is not in the tree', () => {
    expect(indexTree(tree).get('nope')).toBeUndefined();
  });
});

describe('isSelfOrDescendant', () => {
  it('refuses the row itself and everything below it', () => {
    expect(isSelfOrDescendant(first, 'a')).toBe(true);
    expect(isSelfOrDescendant(first, 'a1x')).toBe(true);
  });

  it('allows a row from another branch', () => {
    expect(isSelfOrDescendant(first, 'b')).toBe(false);
  });
});
