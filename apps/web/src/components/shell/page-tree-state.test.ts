import { describe, expect, it } from 'vitest';

import { type DocumentTreeNode } from '@exocortex/contracts';

import { treeBranch } from '@/test-support/document-tree';

import {
  ancestorsOf,
  canCollapseAll,
  collapseAll,
  dropRequest,
  dropZoneAt,
  expandSiblings,
  indexTree,
  isSelfOrDescendant,
  nudgeRequest,
  parseExpanded,
  setSubtree,
} from './page-tree-state';

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

describe('dropZoneAt', () => {
  it('reads the edges as between and the middle half as into', () => {
    expect(dropZoneAt(0.1)).toBe('before');
    expect(dropZoneAt(0.5)).toBe('inside');
    expect(dropZoneAt(0.9)).toBe('after');
  });
});

describe('dropRequest', () => {
  const positions = indexTree(tree);

  it('drops into a row as its child', () => {
    expect(dropRequest(positions, 'a1', 'inside')).toEqual({ parentId: 'a1' });
  });

  it("drops beside a row under that row's parent", () => {
    expect(dropRequest(positions, 'a2', 'before')).toEqual({
      parentId: 'a',
      beforeSiblingId: 'a2',
    });
    expect(dropRequest(positions, 'b', 'after')).toEqual({ parentId: null, afterSiblingId: 'b' });
  });

  it('asks for nothing when the target is not in the tree', () => {
    expect(dropRequest(positions, 'nope', 'inside')).toBeNull();
  });
});

describe('nudgeRequest', () => {
  const positions = indexTree(tree);

  it('swaps with the neighbour above or below', () => {
    expect(nudgeRequest(positions, 'a2', 'up')).toEqual({ parentId: 'a', beforeSiblingId: 'a1' });
    expect(nudgeRequest(positions, 'a1', 'down')).toEqual({ parentId: 'a', afterSiblingId: 'a2' });
  });

  it('indents into the page above and outdents to after the parent', () => {
    expect(nudgeRequest(positions, 'a2', 'in')).toEqual({ parentId: 'a1' });
    expect(nudgeRequest(positions, 'a1x', 'out')).toEqual({ parentId: 'a', afterSiblingId: 'a1' });
  });

  it('refuses the moves that have nowhere to go', () => {
    // The first sibling has nothing above it, the last nothing below, and a
    // root page has no parent to leave.
    expect(nudgeRequest(positions, 'a1', 'up')).toBeNull();
    expect(nudgeRequest(positions, 'a1', 'in')).toBeNull();
    expect(nudgeRequest(positions, 'b', 'down')).toBeNull();
    expect(nudgeRequest(positions, 'a', 'out')).toBeNull();
  });
});

describe('collapseAll', () => {
  it('folds everything when no page is open', () => {
    expect(collapseAll(tree, undefined)).toEqual({});
  });

  it('keeps the way down to the open page', () => {
    expect(collapseAll(tree, 'a1x')).toEqual({ a: true, a1: true });
    expect(collapseAll(tree, 'b')).toEqual({});
  });

  it('only offers itself when something beyond that path is open', () => {
    expect(canCollapseAll(tree, { a: true, a1: true }, 'a1x')).toBe(false);
    expect(canCollapseAll(tree, { a: true, a1: true }, undefined)).toBe(true);
    expect(canCollapseAll(tree, {}, undefined)).toBe(false);
  });
});

describe('setSubtree', () => {
  it('unfolds the row and every branch below it, and no leaf', () => {
    expect(setSubtree({ b: true }, first, true)).toEqual({ a: true, a1: true, b: true });
  });

  it('folds the whole branch, so reopening it does not spring back', () => {
    expect(setSubtree({ a: true, a1: true, b: true }, first, false)).toEqual({ b: true });
  });
});

describe('expandSiblings', () => {
  it('unfolds every sibling that has pages below it', () => {
    expect(expandSiblings({}, tree)).toEqual({ a: true });
  });
});
