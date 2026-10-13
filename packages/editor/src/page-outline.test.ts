import { describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { HEADING_COLLAPSED_ATTRIBUTE } from './collapsible-heading';
import { type ProseMirrorDocument } from './contract';
import { type PageOutlineEntry, readPageOutline, sameOutline } from './page-outline';
import { getExocortexSchema } from './schema';

type Block =
  | { heading: number; id: string; collapsed?: boolean; text?: string }
  | { text: string }
  | { callout: readonly Block[] }
  | { columns: readonly (readonly Block[])[] };

function toNode(block: Block): NonNullable<ProseMirrorDocument['content']>[number] {
  if ('heading' in block) {
    const text = block.text ?? block.id;
    return {
      type: 'heading',
      attrs: {
        level: block.heading,
        [BLOCK_ID_ATTRIBUTE]: block.id,
        [HEADING_COLLAPSED_ATTRIBUTE]: block.collapsed === true,
      },
      content: text.length === 0 ? [] : [{ type: 'text', text }],
    };
  }
  if ('callout' in block) {
    return { type: 'callout', content: block.callout.map(toNode) };
  }
  if ('columns' in block) {
    return {
      type: 'columnList',
      content: block.columns.map((column) => ({ type: 'column', content: column.map(toNode) })),
    };
  }
  return { type: 'paragraph', content: [{ type: 'text', text: block.text }] };
}

function outline(blocks: readonly Block[]): PageOutlineEntry[] {
  const document: ProseMirrorDocument = { type: 'doc', content: blocks.map(toNode) };
  return readPageOutline(getExocortexSchema().nodeFromJSON(document));
}

/** `id:level` plus `>hider` when hidden and `+` when collapsed, one per entry. */
function shape(entries: readonly PageOutlineEntry[]): string[] {
  return entries.map(
    (entry) =>
      `${entry.blockId ?? '?'}:${String(entry.level)}` +
      (entry.collapsed ? '+' : '') +
      (entry.hiddenUnder === null ? '' : `>${entry.hiddenUnder}`),
  );
}

describe('readPageOutline', () => {
  it('lists every heading in document order with its level and text', () => {
    const entries = outline([
      { heading: 1, id: 'a', text: '  Einleitung ' },
      { text: 'Absatz' },
      { heading: 2, id: 'b' },
      { heading: 3, id: 'c' },
      { heading: 2, id: 'd', text: '' },
    ]);
    expect(shape(entries)).toEqual(['a:1', 'b:2', 'c:3', 'd:2']);
    expect(entries[0]?.text).toBe('Einleitung');
    expect(entries[3]?.text).toBe('');
  });

  it('marks the headings a collapsed section hides, and names the heading hiding them', () => {
    const entries = outline([
      { heading: 1, id: 'a', collapsed: true },
      { heading: 2, id: 'b' },
      { text: 'versteckt' },
      { heading: 3, id: 'c', collapsed: true },
      { heading: 1, id: 'd' },
      { heading: 2, id: 'e' },
    ]);
    // `c` is collapsed in the document, but inside a hidden section it governs
    // nothing, exactly as in `collapsedDecorations`.
    expect(shape(entries)).toEqual(['a:1+', 'b:2>a', 'c:3>a', 'd:1', 'e:2']);
  });

  it('ends a collapsed section at the next heading of the same or a higher level', () => {
    const entries = outline([
      { heading: 2, id: 'a', collapsed: true },
      { heading: 3, id: 'b' },
      { heading: 2, id: 'c' },
      { heading: 1, id: 'd' },
    ]);
    expect(shape(entries)).toEqual(['a:2+', 'b:3>a', 'c:2', 'd:1']);
  });

  it('lets a heading inside a hidden callout inherit the hiding', () => {
    const entries = outline([
      { heading: 1, id: 'a', collapsed: true },
      { callout: [{ heading: 2, id: 'b' }] },
      { heading: 1, id: 'c' },
      {
        callout: [
          { heading: 2, id: 'd', collapsed: true },
          { heading: 3, id: 'e' },
        ],
      },
    ]);
    // A callout does not govern collapsing, so `d` hides nothing and is not
    // reported as collapsed.
    expect(shape(entries)).toEqual(['a:1+', 'b:2>a', 'c:1', 'd:2', 'e:3']);
  });

  it('collapses inside a column the way the decorations do', () => {
    const entries = outline([
      {
        columns: [
          [
            { heading: 2, id: 'a', collapsed: true },
            { heading: 3, id: 'b' },
          ],
          [{ heading: 2, id: 'c' }],
        ],
      },
    ]);
    expect(shape(entries)).toEqual(['a:2+', 'b:3>a', 'c:2']);
  });
});

describe('sameOutline', () => {
  it('tells a changed heading from an unchanged outline', () => {
    const before = outline([{ heading: 1, id: 'a' }]);
    expect(sameOutline(before, outline([{ heading: 1, id: 'a' }]))).toBe(true);
    expect(sameOutline(before, outline([{ heading: 1, id: 'a', text: 'neu' }]))).toBe(false);
    expect(sameOutline(before, outline([{ heading: 2, id: 'a' }]))).toBe(false);
    expect(sameOutline(before, [])).toBe(false);
  });
});
