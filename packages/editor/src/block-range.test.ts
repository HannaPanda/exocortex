import { describe, expect, it } from 'vitest';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import { applyBlockRangeEditToState, type BlockRangeEdit, BlockRangeError } from './block-range';
import { type ProseMirrorDocument } from './contract';
import { parseMarkdown, serializeMarkdown } from './markdown';
import { proseMirrorJsonToYjsState } from './yjs';

/** The page every test in this file edits. Four blocks, each with an address. */
const PAGE: ProseMirrorDocument = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2, [BLOCK_ID_ATTRIBUTE]: 'headingaaaa' },
      content: [{ type: 'text', text: 'Stand' }],
    },
    {
      type: 'paragraph',
      attrs: { [BLOCK_ID_ATTRIBUTE]: 'paraaaaaaaa1' },
      content: [{ type: 'text', text: 'Erster Absatz.' }],
    },
    {
      type: 'paragraph',
      attrs: { [BLOCK_ID_ATTRIBUTE]: 'paraaaaaaaa2' },
      content: [{ type: 'text', text: 'Zweiter Absatz.' }],
    },
    {
      type: 'heading',
      attrs: { level: 2, [BLOCK_ID_ATTRIBUTE]: 'headingbbbb' },
      content: [{ type: 'text', text: 'Danach' }],
    },
  ],
};

function content(markdown: string): ProseMirrorDocument {
  return parseMarkdown(markdown).document;
}

function idsOf(document: ProseMirrorDocument): (string | undefined)[] {
  return (document.content ?? []).map((node) => node.attrs?.[BLOCK_ID_ATTRIBUTE] as string);
}

describe('applyBlockRangeEditToState', () => {
  const state = (): Uint8Array => proseMirrorJsonToYjsState(PAGE);

  it('replaces one block and leaves every other identifier alone', () => {
    const applied = applyBlockRangeEditToState(state(), content('Ersetzt.'), {
      fromBlockId: 'paraaaaaaaa1',
      toBlockId: null,
      placement: 'replace',
    });

    expect(serializeMarkdown(applied.proseMirrorJson)).toContain('Ersetzt.');
    expect(serializeMarkdown(applied.proseMirrorJson)).not.toContain('Erster Absatz.');
    // The three blocks that were not addressed are the same blocks, not
    // rebuilt copies of them. That is the whole promise of a narrow write.
    const ids = idsOf(applied.proseMirrorJson);
    expect([ids[0], ids[2], ids[3]]).toEqual(['headingaaaa', 'paraaaaaaaa2', 'headingbbbb']);
  });

  it('inserts before and after without removing anything', () => {
    const before = applyBlockRangeEditToState(state(), content('Davor.'), {
      fromBlockId: 'paraaaaaaaa1',
      toBlockId: null,
      placement: 'before',
    });
    expect(idsOf(before.proseMirrorJson)).toHaveLength(5);
    expect(serializeMarkdown(before.proseMirrorJson).indexOf('Davor.')).toBeLessThan(
      serializeMarkdown(before.proseMirrorJson).indexOf('Erster Absatz.'),
    );

    const after = applyBlockRangeEditToState(state(), content('Danach eingefügt.'), {
      fromBlockId: 'paraaaaaaaa1',
      toBlockId: null,
      placement: 'after',
    });
    const markdown = serializeMarkdown(after.proseMirrorJson);
    expect(markdown.indexOf('Erster Absatz.')).toBeLessThan(markdown.indexOf('Danach eingefügt.'));
  });

  it('replaces a range spanning two blocks with one', () => {
    const applied = applyBlockRangeEditToState(state(), content('Beides zusammen.'), {
      fromBlockId: 'paraaaaaaaa1',
      toBlockId: 'paraaaaaaaa2',
      placement: 'replace',
    });

    expect(idsOf(applied.proseMirrorJson)).toHaveLength(3);
    const markdown = serializeMarkdown(applied.proseMirrorJson);
    expect(markdown).toContain('Beides zusammen.');
    expect(markdown).not.toContain('Zweiter Absatz.');
  });

  it('reports the identifiers of what it wrote', () => {
    const applied = applyBlockRangeEditToState(state(), content('Eins\n\nZwei'), {
      fromBlockId: 'paraaaaaaaa1',
      toBlockId: null,
      placement: 'replace',
    });
    expect(applied.blockIds).toHaveLength(2);
  });

  it('refuses a block that is not on the page, without touching it', () => {
    const edit: BlockRangeEdit = {
      fromBlockId: 'nichtvorhanden',
      toBlockId: null,
      placement: 'replace',
    };
    expect(() => applyBlockRangeEditToState(state(), content('x'), edit)).toThrow(BlockRangeError);
    try {
      applyBlockRangeEditToState(state(), content('x'), edit);
    } catch (error) {
      expect((error as BlockRangeError).reason).toBe('block_not_found');
    }
  });

  it('refuses a range whose end sits before its start', () => {
    try {
      applyBlockRangeEditToState(state(), content('x'), {
        fromBlockId: 'paraaaaaaaa2',
        toBlockId: 'paraaaaaaaa1',
        placement: 'replace',
      });
      expect.unreachable('inverted range must be refused');
    } catch (error) {
      expect((error as BlockRangeError).reason).toBe('block_range_inverted');
    }
  });

  it('deletes the range when the content is empty, and keeps the rest', () => {
    // How a section leaves a page it was extracted from (issue #118): nothing
    // takes its place, and everything around it keeps its identifier.
    const applied = applyBlockRangeEditToState(
      state(),
      { type: 'doc', content: [] },
      { fromBlockId: 'paraaaaaaaa1', toBlockId: 'paraaaaaaaa2', placement: 'replace' },
    );

    expect(serializeMarkdown(applied.proseMirrorJson)).not.toContain('Absatz');
    expect(idsOf(applied.proseMirrorJson)).toEqual(['headingaaaa', 'headingbbbb']);
    expect(applied.blockIds).toEqual([]);
  });

  it('refuses to delete a range it was told to insert beside', () => {
    expect(() =>
      applyBlockRangeEditToState(
        state(),
        { type: 'doc', content: [] },
        { fromBlockId: 'paraaaaaaaa1', toBlockId: null, placement: 'after' },
      ),
    ).toThrow(/deletes a range/);
  });

  it('leaves an empty page behind when a deletion covers everything', () => {
    // Not a refusal here: Yjs materializes an emptied fragment as one empty
    // paragraph, which is a valid page. Whether emptying a page is a sensible
    // thing to ask for is a question for the caller, and
    // `DocumentSectionExtractService` refuses it there, where the alternatives
    // (a link, an embedding) are known.
    const applied = applyBlockRangeEditToState(
      state(),
      { type: 'doc', content: [] },
      { fromBlockId: 'headingaaaa', toBlockId: 'headingbbbb', placement: 'replace' },
    );

    expect(serializeMarkdown(applied.proseMirrorJson).trim()).toBe('');
  });

  it('refuses two blocks that are not siblings', () => {
    const nested: ProseMirrorDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { [BLOCK_ID_ATTRIBUTE]: 'toplevelaaaa' },
          content: [{ type: 'text', text: 'Oben.' }],
        },
        {
          type: 'bulletList',
          attrs: { [BLOCK_ID_ATTRIBUTE]: 'listaaaaaaaa' },
          content: [
            {
              type: 'listItem',
              attrs: { [BLOCK_ID_ATTRIBUTE]: 'itemaaaaaaaa' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { [BLOCK_ID_ATTRIBUTE]: 'inneraaaaaaa' },
                  content: [{ type: 'text', text: 'Punkt.' }],
                },
              ],
            },
          ],
        },
      ],
    };

    try {
      applyBlockRangeEditToState(proseMirrorJsonToYjsState(nested), content('x'), {
        fromBlockId: 'toplevelaaaa',
        toBlockId: 'inneraaaaaaa',
        placement: 'replace',
      });
      expect.unreachable('a range across two levels must be refused');
    } catch (error) {
      expect((error as BlockRangeError).reason).toBe('block_range_not_siblings');
    }
  });
});
