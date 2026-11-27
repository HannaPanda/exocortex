import { describe, expect, it } from 'vitest';

import {
  BLOCK_ID_ATTRIBUTE,
  type ProseMirrorDocument,
  type ProseMirrorNode,
  writtenTopLevelBlocks,
} from '@exocortex/editor';

import {
  countChanges,
  foldRunWrites,
  judgeCreated,
  judgeMove,
  judgeRename,
  judgeRunBlocks,
  type PageNow,
  type RunJournalRow,
} from './run-changes';

function paragraph(id: string, text: string): ProseMirrorNode {
  return {
    type: 'paragraph',
    attrs: { [BLOCK_ID_ATTRIBUTE]: id },
    content: [{ type: 'text', text }],
  };
}

function doc(...content: ProseMirrorNode[]): ProseMirrorDocument {
  return { type: 'doc', content };
}

/** The journal row a write from `before` to `after` would leave. */
function row(
  before: ProseMirrorDocument,
  after: ProseMirrorDocument,
  snapshot = 'snap1',
): RunJournalRow {
  return {
    documentId: 'page1',
    documentTitle: 'Obst',
    snapshotBeforeId: snapshot,
    writtenBlocks: writtenTopLevelBlocks(before, after),
  };
}

const QUINCE = paragraph('aaaaaaaaaaaq', 'Quitte');
const ORIGINAL = doc(
  paragraph('aaaaaaaaaaa1', 'Apfel'),
  paragraph('aaaaaaaaaaa2', 'Birne'),
  QUINCE,
  paragraph('aaaaaaaaaaa3', 'Pflaume'),
);
// The run rewrote "Birne" in place and replaced "Pflaume" with a new block;
// the untouched "Quitte" between them keeps the two changes apart.
const AFTER_RUN = doc(
  paragraph('aaaaaaaaaaa1', 'Apfel'),
  paragraph('aaaaaaaaaaa2', 'Kirsche'),
  QUINCE,
  paragraph('bbbbbbbbbbb3', 'Pflaumen'),
);

function judge(current: ProseMirrorDocument, rows = [row(ORIGINAL, AFTER_RUN)]) {
  const [page] = foldRunWrites(rows);
  if (page === undefined) throw new Error('no page');
  return judgeRunBlocks(ORIGINAL, current, page);
}

describe('judgeRunBlocks', () => {
  it('offers every change back while the page is as the run left it', () => {
    const blocks = judge(AFTER_RUN);
    expect(blocks.every((block) => block.state === 'revertible')).toBe(true);
    expect(countChanges(blocks)).toEqual({ revertible: 2, changed_since: 0, reverted: 0 });
  });

  it('holds back a change somebody edited since, and only that one', () => {
    const blocks = judge(
      doc(
        paragraph('aaaaaaaaaaa1', 'Apfel'),
        paragraph('aaaaaaaaaaa2', 'Kirsche'),
        QUINCE,
        paragraph('bbbbbbbbbbb3', 'Zwetschgen'),
      ),
    );
    expect(blocks.find((block) => block.blockId === 'aaaaaaaaaaa2')?.state).toBe('revertible');
    // The replaced block and its replacement are one change: neither goes back.
    expect(blocks.find((block) => block.blockId === 'aaaaaaaaaaa3')?.state).toBe('changed_since');
    expect(blocks.find((block) => block.blockId === 'bbbbbbbbbbb3')?.state).toBe('changed_since');
    expect(blocks.find((block) => block.blockId === 'bbbbbbbbbbb3')?.excerpt).toBe('Zwetschgen');
  });

  it('treats a deleted replacement without the original back as somebody else’s doing', () => {
    const blocks = judge(
      doc(paragraph('aaaaaaaaaaa1', 'Apfel'), paragraph('aaaaaaaaaaa2', 'Kirsche'), QUINCE),
    );
    expect(blocks.find((block) => block.blockId === 'aaaaaaaaaaa3')?.state).toBe('changed_since');
  });

  it('says a change is already back when the page holds the earlier version', () => {
    const blocks = judge(ORIGINAL);
    expect(countChanges(blocks)).toEqual({ revertible: 0, changed_since: 0, reverted: 2 });
  });

  it('keeps the earliest snapshot and the latest state across several writes', () => {
    const second = doc(
      paragraph('aaaaaaaaaaa1', 'Apfel'),
      paragraph('aaaaaaaaaaa2', 'Kirschen'),
      QUINCE,
      paragraph('bbbbbbbbbbb3', 'Pflaumen'),
    );
    const rows = [row(ORIGINAL, AFTER_RUN, 'snap1'), row(AFTER_RUN, second, 'snap2')];
    const [page] = foldRunWrites(rows);
    expect(page?.snapshotId).toBe('snap1');
    const blocks = judge(second, rows);
    expect(blocks.find((block) => block.blockId === 'aaaaaaaaaaa2')?.state).toBe('revertible');
  });

  it('marks a page whose writes were not recorded block by block', () => {
    const [page] = foldRunWrites([{ ...row(ORIGINAL, AFTER_RUN), writtenBlocks: null }]);
    expect(page?.unrecorded).toBe(true);
  });
});

describe('what stands where a held-back block stood', () => {
  it('shows the rewrite under a new identifier, not the run’s text', () => {
    const blocks = judge(
      doc(
        paragraph('aaaaaaaaaaa1', 'Apfel'),
        paragraph('aaaaaaaaaaa2', 'Kirsche'),
        QUINCE,
        paragraph('ccccccccccc3', 'Zwetschgen'),
      ),
    );
    const replacement = blocks.find((block) => block.blockId === 'bbbbbbbbbbb3');
    expect(replacement?.state).toBe('changed_since');
    expect(replacement?.excerpt).toBeNull();
    const standing = blocks.flatMap((block) => block.standing);
    expect(standing.map((entry) => entry.excerpt)).toEqual(['Zwetschgen']);
  });

  it('finds the place of a block the run added from the journal', () => {
    const added = doc(...(ORIGINAL.content ?? []), paragraph('bbbbbbbbbbb9', 'Neu'));
    const rows = [row(ORIGINAL, added)];
    const [page] = foldRunWrites(rows);
    if (page === undefined) throw new Error('no page');
    const blocks = judgeRunBlocks(
      ORIGINAL,
      doc(...(ORIGINAL.content ?? []), paragraph('ccccccccccc9', 'Umgeschrieben')),
      page,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.standing.map((entry) => entry.excerpt)).toEqual(['Umgeschrieben']);
  });

  it('claims nothing for a change that goes back', () => {
    expect(judge(AFTER_RUN).every((block) => block.standing.length === 0)).toBe(true);
  });
});

const NOW: PageNow = {
  title: 'Neu',
  parentId: 'parent2',
  workspaceId: 'ws1',
  orderKey: 'b',
  archived: false,
  type: 'PAGE',
};

describe('judging a page’s structure', () => {
  it('takes a rename back only while the run’s title stands', () => {
    const rename = { from: 'Alt', to: 'Neu' };
    expect(judgeRename(rename, NOW).state).toBe('revertible');
    expect(judgeRename(rename, { ...NOW, title: 'Alt' }).state).toBe('reverted');
    expect(judgeRename(rename, { ...NOW, title: 'Anders' })).toEqual({
      state: 'changed_since',
      reason: 'renamed',
    });
  });

  const move = {
    fromParentId: 'parent1',
    toParentId: 'parent2',
    fromWorkspaceId: 'ws1',
    toWorkspaceId: 'ws1',
    fromOrderKey: 'a',
    toOrderKey: 'b',
  };

  it('takes a move back while the page stands where the run put it', () => {
    expect(judgeMove(move, NOW, true).state).toBe('revertible');
    expect(judgeMove(move, { ...NOW, parentId: 'parent1' }, true).state).toBe('reverted');
    expect(judgeMove(move, { ...NOW, parentId: 'parent3' }, true).reason).toBe('moved');
    expect(judgeMove(move, NOW, false).reason).toBe('parent_gone');
    expect(judgeMove(move, { ...NOW, archived: true }, true).reason).toBe('trashed');
  });

  it('names a move between workspaces without undoing it', () => {
    const across = { ...move, toWorkspaceId: 'ws2' };
    expect(judgeMove(across, { ...NOW, workspaceId: 'ws2' }, true).reason).toBe('other_workspace');
  });

  it('compares the place among siblings for a move under the same parent', () => {
    const reorder = { ...move, fromParentId: 'parent2' };
    expect(judgeMove(reorder, NOW, true).state).toBe('revertible');
    expect(judgeMove(reorder, { ...NOW, orderKey: 'c' }, true).reason).toBe('moved');
  });

  const created = { pageAfter: 'fp1', titleAfter: 'Neu' };
  const facts = {
    now: NOW,
    contentNow: 'fp1',
    propertiesTouched: false,
    children: 'none' as const,
  };

  it('sends a new page to the trash only while nobody has been in it', () => {
    expect(judgeCreated(created, facts).state).toBe('revertible');
    expect(judgeCreated(created, { ...facts, now: { ...NOW, archived: true } }).state).toBe(
      'reverted',
    );
    expect(judgeCreated(created, { ...facts, contentNow: 'fp2' }).reason).toBe('edited');
    expect(judgeCreated(created, { ...facts, propertiesTouched: true }).reason).toBe('edited');
    expect(judgeCreated(created, { ...facts, now: { ...NOW, title: 'X' } }).reason).toBe('renamed');
    expect(judgeCreated(created, { ...facts, children: 'foreign' }).reason).toBe('children');
    expect(judgeCreated(created, { ...facts, now: { ...NOW, type: 'COLLECTION' } }).reason).toBe(
      'not_a_page',
    );
    expect(judgeCreated({ ...created, pageAfter: null }, facts).reason).toBe('not_recorded');
  });

  it('folds several renames and moves to the first before and the last after', () => {
    const base = { documentId: 'page1', documentTitle: 'Neu', snapshotBeforeId: null };
    const [page] = foldRunWrites([
      { ...base, writtenBlocks: null, structure: { kind: 'renamed', from: 'Alt', to: 'Mitte' } },
      { ...base, writtenBlocks: null, structure: { kind: 'renamed', from: 'Mitte', to: 'Neu' } },
      { ...base, writtenBlocks: null, structure: { kind: 'moved', ...move } },
      {
        ...base,
        writtenBlocks: null,
        structure: {
          kind: 'moved',
          ...move,
          fromParentId: 'parent2',
          toParentId: 'parent1',
          fromOrderKey: 'b',
          toOrderKey: 'a',
        },
      },
    ]);
    expect(page?.rename).toEqual({ from: 'Alt', to: 'Neu' });
    // Moved away and back to the same place: nothing to take back.
    expect(page?.move).toBeNull();
  });
});
