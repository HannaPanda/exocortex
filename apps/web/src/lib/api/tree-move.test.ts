import { describe, expect, it } from 'vitest';

import { type DocumentTreeResponse } from '@exocortex/contracts';

import { treeBranch } from '@/test-support/document-tree';

import { applyOptimisticMove, containsNode } from './tree-move';

/**
 * a
 *   a1
 *     a1x
 *   a2
 * b
 */
function tree(): DocumentTreeResponse {
  return {
    nodes: [
      treeBranch('a', null, [
        treeBranch('a1', 'a', [treeBranch('a1x', 'a1')]),
        treeBranch('a2', 'a'),
      ]),
      treeBranch('b', null),
    ],
    archived: [],
    path: [],
    totalCount: 5,
  };
}

/** The tree as `parent>child` lines, which is what a move actually changes. */
function shape(response: DocumentTreeResponse): string[] {
  const lines: string[] = [];
  const walk = (nodes: DocumentTreeResponse['nodes'], prefix: string): void => {
    for (const node of nodes) {
      lines.push(`${prefix}${node.id}`);
      walk(node.children, `${prefix}${node.id}>`);
    }
  };
  walk(response.nodes, '');
  return lines;
}

describe('applyOptimisticMove', () => {
  it('moves a page under a new parent', () => {
    const next = applyOptimisticMove(tree(), 'b', { parentId: 'a1' });

    expect(next).not.toBeNull();
    expect(shape(next as DocumentTreeResponse)).toEqual([
      'a',
      'a>a1',
      'a>a1>a1x',
      'a>a1>b',
      'a>a2',
    ]);
  });

  it('records the new parent on the moved node', () => {
    const next = applyOptimisticMove(tree(), 'b', { parentId: 'a' });

    expect(next?.nodes[0]?.children.at(-1)).toMatchObject({ id: 'b', parentId: 'a' });
  });

  it('puts a page before its anchor', () => {
    const next = applyOptimisticMove(tree(), 'a2', { parentId: 'a', beforeSiblingId: 'a1' });

    expect(next?.nodes[0]?.children.map((node) => node.id)).toEqual(['a2', 'a1']);
  });

  it('puts a page after its anchor', () => {
    const next = applyOptimisticMove(tree(), 'b', { parentId: 'a', afterSiblingId: 'a1' });

    expect(next?.nodes[0]?.children.map((node) => node.id)).toEqual(['a1', 'b', 'a2']);
  });

  it('appends to the end when no anchor is given', () => {
    const next = applyOptimisticMove(tree(), 'a1', { parentId: null });

    expect(next?.nodes.map((node) => node.id)).toEqual(['a', 'b', 'a1']);
  });

  it('carries the subtree along', () => {
    const next = applyOptimisticMove(tree(), 'a1', { parentId: 'b' });

    expect(shape(next as DocumentTreeResponse)).toEqual(['a', 'a>a2', 'b', 'b>a1', 'b>a1>a1x']);
  });

  it('counts the anchor from the tree the move already left', () => {
    // Moving a1 down past a2: with a1 still in the list, index 1 would put it
    // back where it was. The anchor has to be read after the removal.
    const next = applyOptimisticMove(tree(), 'a1', { parentId: 'a', afterSiblingId: 'a2' });

    expect(next?.nodes[0]?.children.map((node) => node.id)).toEqual(['a2', 'a1']);
  });

  it('leaves the original tree untouched', () => {
    const before = tree();
    applyOptimisticMove(before, 'b', { parentId: 'a' });

    expect(shape(before)).toEqual(['a', 'a>a1', 'a>a1>a1x', 'a>a2', 'b']);
  });

  it('refuses a move into the page itself', () => {
    expect(applyOptimisticMove(tree(), 'a', { parentId: 'a' })).toBeNull();
  });

  it('refuses a move into its own subtree', () => {
    expect(applyOptimisticMove(tree(), 'a', { parentId: 'a1x' })).toBeNull();
  });

  it('refuses a move into another workspace', () => {
    // Nothing local can draw that, so the tree waits for the server rather than
    // guessing.
    expect(applyOptimisticMove(tree(), 'b', { parentId: null, workspaceId: 'other' })).toBeNull();
  });

  it('refuses a move of a page it does not know', () => {
    expect(applyOptimisticMove(tree(), 'nope', { parentId: 'a' })).toBeNull();
  });

  it('refuses a parent it does not know', () => {
    expect(applyOptimisticMove(tree(), 'b', { parentId: 'nope' })).toBeNull();
  });

  it('refuses an anchor that is not among the new siblings', () => {
    expect(applyOptimisticMove(tree(), 'b', { parentId: 'a', beforeSiblingId: 'nope' })).toBeNull();
  });
});

describe('containsNode', () => {
  it('finds the node itself and its descendants', () => {
    const root = tree().nodes[0];

    expect(containsNode(root!, 'a')).toBe(true);
    expect(containsNode(root!, 'a1x')).toBe(true);
    expect(containsNode(root!, 'b')).toBe(false);
  });
});
