import { describe, expect, it } from 'vitest';

import {
  BLOCK_ID_ATTRIBUTE,
  type ProseMirrorDocument,
  type ProseMirrorNode,
  writtenTopLevelBlocks,
} from '@exocortex/editor';

import { countChanges, foldRunWrites, judgeRunBlocks, type RunJournalRow } from './run-changes';

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
