import { describe, expect, it } from 'vitest';

import { type DocumentSummary, type DocumentTreeResponse } from '@exocortex/contracts';

import { treeNode } from '@/test-support/document-tree';

import { applyRowEvent } from './tree-row-events';

// A section holding two databases; the second has one row with a sub-page,
// which the tree keeps (issue #221).
const tree: DocumentTreeResponse = {
  nodes: [
    treeNode('section', [
      treeNode('meals', [], { parentId: 'section', type: 'COLLECTION', rowCount: 3 }),
      treeNode(
        'books',
        [treeNode('book-with-notes', [treeNode('notes', [], { parentId: 'book-with-notes' })])],
        { parentId: 'section', type: 'COLLECTION', rowCount: 2 },
      ),
    ]),
  ],
  archived: [],
  path: [],
  totalCount: 9,
};

const row = (id: string, parentId: string | null): DocumentSummary => {
  const { children: _children, rowCount: _rowCount, ...summary } = treeNode(id, [], { parentId });
  return summary;
};

const countOf = (answer: DocumentTreeResponse | null, id: string): number | undefined => {
  const find = (nodes: DocumentTreeResponse['nodes']): number | undefined => {
    for (const node of nodes) {
      if (node.id === id) return node.rowCount;
      const below = find(node.children);
      if (below !== undefined) return below;
    }
    return undefined;
  };
  return answer === null ? undefined : find(answer.nodes);
};

describe('applyRowEvent', () => {
  it('counts a new row on its database instead of refetching', () => {
    const next = applyRowEvent(tree, { kind: 'created', document: row('r4', 'meals') });
    expect(countOf(next, 'meals')).toBe(4);
    expect(countOf(next, 'books')).toBe(2);
    expect(next?.totalCount).toBe(10);
  });

  it('takes an archived row off the count and puts a restored one back', () => {
    const next = applyRowEvent(tree, { kind: 'archived', document: row('r1', 'meals') });
    expect(countOf(next, 'meals')).toBe(2);

    const restored =
      next === null
        ? null
        : applyRowEvent(next, { kind: 'restored', document: row('r1', 'meals') });
    expect(countOf(restored, 'meals')).toBe(3);
    expect(restored?.archived).toEqual([]);
  });

  it('changes nothing for a renamed row or one moved within its table', () => {
    expect(applyRowEvent(tree, { kind: 'updated', document: row('r1', 'meals') })).toBe(tree);
    expect(
      applyRowEvent(tree, {
        kind: 'moved',
        document: row('r1', 'meals'),
        previousParentId: 'meals',
      }),
    ).toBe(tree);
  });

  it('moves the count when a row changes tables', () => {
    const next = applyRowEvent(tree, {
      kind: 'moved',
      document: row('r1', 'books'),
      previousParentId: 'meals',
    });
    expect(countOf(next, 'meals')).toBe(2);
    expect(countOf(next, 'books')).toBe(3);
    expect(next?.totalCount).toBe(9);
  });

  it('refetches for anything the tree shows or would have to place', () => {
    // A plain page.
    expect(applyRowEvent(tree, { kind: 'created', document: row('p', 'section') })).toBeNull();
    // A row the tree lists because it has a sub-page.
    expect(
      applyRowEvent(tree, { kind: 'updated', document: row('book-with-notes', 'books') }),
    ).toBeNull();
    // A page moved into a table from outside, and a row moved out of one.
    expect(
      applyRowEvent(tree, {
        kind: 'moved',
        document: row('p', 'meals'),
        previousParentId: 'section',
      }),
    ).toBeNull();
    expect(
      applyRowEvent(tree, {
        kind: 'moved',
        document: row('r1', 'section'),
        previousParentId: 'meals',
      }),
    ).toBeNull();
  });
});
