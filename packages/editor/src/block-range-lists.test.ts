import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { BLOCK_ID_ATTRIBUTE } from './block-id';
import {
  applyBlockRangeEditToState,
  applyBlockRangeEditToYDoc,
  type BlockRangeEdit,
  BlockRangeError,
  type BlockRangeRefusal,
} from './block-range';
import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';
import { parseMarkdown, serializeMarkdown } from './markdown';
import { validateProseMirrorDocument } from './schema';
import { proseMirrorJsonToYjsState, yjsStateToDocument, yjsStateToProseMirrorJson } from './yjs';

/*
 * Lists under a narrow write (issue #247): list items aimed at a list join it,
 * a deletion removes rather than leaves a shell, and a list that loses its last
 * item goes with it.
 */

function text(id: string, value: string): ProseMirrorNode {
  return {
    type: 'paragraph',
    attrs: { [BLOCK_ID_ATTRIBUTE]: id },
    content: [{ type: 'text', text: value }],
  };
}

function item(id: string, value: string, nested: ProseMirrorNode[] = []): ProseMirrorNode {
  return {
    type: 'listItem',
    attrs: { [BLOCK_ID_ATTRIBUTE]: id },
    content: [text(`${id}t`, value), ...nested],
  };
}

function list(type: string, id: string, items: ProseMirrorNode[]): ProseMirrorNode {
  return { type, attrs: { [BLOCK_ID_ATTRIBUTE]: id }, content: items };
}

/** Two independent bullet lists with a paragraph between them, and a task list. */
const PAGE: ProseMirrorDocument = {
  type: 'doc',
  content: [
    text('introaaaaaaa', 'Einleitung.'),
    list('bulletList', 'listaaaaaaaa', [
      item('itemaaaaaaa1', 'eins'),
      item('itemaaaaaaa2', 'zwei', [
        list('bulletList', 'subaaaaaaaaa', [item('subitemaaaa1', 'zwei.a')]),
      ]),
    ]),
    text('betweenaaaaa', 'Dazwischen.'),
    list('bulletList', 'listbbbbbbbb', [item('itembbbbbbb1', 'andere Liste')]),
    {
      type: 'taskList',
      attrs: { [BLOCK_ID_ATTRIBUTE]: 'tasksaaaaaaa' },
      content: [
        {
          type: 'taskItem',
          attrs: { [BLOCK_ID_ATTRIBUTE]: 'taskaaaaaaa1', checked: false },
          content: [text('taskaaaaaaa1t', 'Aufgabe')],
        },
      ],
    },
  ],
};

function apply(markdown: string, edit: Partial<BlockRangeEdit> & { fromBlockId: string }) {
  const document: ProseMirrorDocument =
    markdown === '' ? { type: 'doc', content: [] } : parseMarkdown(markdown).document;
  return applyBlockRangeEditToState(proseMirrorJsonToYjsState(PAGE), document, {
    toBlockId: null,
    placement: 'after',
    ...edit,
  });
}

function reasonOf(run: () => unknown): BlockRangeRefusal | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof BlockRangeError ? error.reason : null;
  }
}

function topTypes(document: ProseMirrorDocument): string[] {
  return (document.content ?? []).map((node) => node.type);
}

function itemTexts(node: ProseMirrorNode): string[] {
  return (node.content ?? []).map((entry) => {
    const paragraph = entry.content?.[0];
    return paragraph?.content?.[0]?.text ?? '';
  });
}

describe('appending list items to a list (issue #247)', () => {
  it('adds the items to the end of the addressed list instead of a second list', () => {
    const applied = apply('- drei\n- vier', { fromBlockId: 'listaaaaaaaa' });
    const after = applied.proseMirrorJson;

    // Still exactly the lists there were: nothing new beside them.
    expect(topTypes(after)).toEqual(topTypes(PAGE));
    expect(itemTexts(after.content?.[1] as ProseMirrorNode)).toEqual([
      'eins',
      'zwei',
      'drei',
      'vier',
    ]);
    // The neighbouring list is untouched, so it is not merged into.
    expect(itemTexts(after.content?.[3] as ProseMirrorNode)).toEqual(['andere Liste']);
    expect(applied.blockIds).toHaveLength(2);
    expect(validateProseMirrorDocument(after).valid).toBe(true);
  });

  it('prepends to the start of the list', () => {
    const applied = apply('- null', { fromBlockId: 'listaaaaaaaa', placement: 'before' });
    expect(itemTexts(applied.proseMirrorJson.content?.[1] as ProseMirrorNode)).toEqual([
      'null',
      'eins',
      'zwei',
    ]);
  });

  it('inserts right after an addressed item, keeping the nesting it carries', () => {
    const applied = apply('- eins.5\n  - eins.5.a', { fromBlockId: 'itemaaaaaaa1' });
    const target = applied.proseMirrorJson.content?.[1] as ProseMirrorNode;

    expect(itemTexts(target)).toEqual(['eins', 'eins.5', 'zwei']);
    const inserted = target.content?.[1] as ProseMirrorNode;
    expect(inserted.content?.[1]?.type).toBe('bulletList');
    expect(topTypes(applied.proseMirrorJson)).toEqual(topTypes(PAGE));
  });

  it('treats the paragraph that is an item’s text as the item', () => {
    // `exo_page_read` writes "- eins ^itemaaaaaaa1t ^itemaaaaaaa1"; either id means the entry.
    const applied = apply('- eins.5', { fromBlockId: 'itemaaaaaaa1t' });
    expect(itemTexts(applied.proseMirrorJson.content?.[1] as ProseMirrorNode)).toEqual([
      'eins',
      'eins.5',
      'zwei',
    ]);
  });

  it('adds to a nested list at its own level', () => {
    const applied = apply('- zwei.b', { fromBlockId: 'subitemaaaa1' });
    const outer = applied.proseMirrorJson.content?.[1] as ProseMirrorNode;
    expect(itemTexts(outer)).toEqual(['eins', 'zwei']);
    const nested = outer.content?.[1]?.content?.[1] as ProseMirrorNode;
    expect(itemTexts(nested)).toEqual(['zwei.a', 'zwei.b']);
  });

  it('replaces an item with the items sent for it', () => {
    const applied = apply('- EINS\n- EINS und mehr', {
      fromBlockId: 'itemaaaaaaa1',
      placement: 'replace',
    });
    expect(itemTexts(applied.proseMirrorJson.content?.[1] as ProseMirrorNode)).toEqual([
      'EINS',
      'EINS und mehr',
      'zwei',
    ]);
  });

  it('lets a numbered item join a bullet list, which keeps its own markers', () => {
    const applied = apply('1. drei', { fromBlockId: 'listaaaaaaaa' });
    const target = applied.proseMirrorJson.content?.[1] as ProseMirrorNode;
    expect(target.type).toBe('bulletList');
    expect(itemTexts(target)).toEqual(['eins', 'zwei', 'drei']);
  });

  it('adds task items to a task list', () => {
    const applied = apply('- [ ] Noch eine', { fromBlockId: 'tasksaaaaaaa' });
    expect(itemTexts(applied.proseMirrorJson.content?.[4] as ProseMirrorNode)).toEqual([
      'Aufgabe',
      'Noch eine',
    ]);
  });

  it('refuses task items for a bullet list and bullet items for a task list', () => {
    expect(reasonOf(() => apply('- [ ] Aufgabe', { fromBlockId: 'listaaaaaaaa' }))).toBe(
      'list_kind_mismatch',
    );
    expect(reasonOf(() => apply('- Punkt', { fromBlockId: 'taskaaaaaaa1' }))).toBe(
      'list_kind_mismatch',
    );
  });

  it('refuses a paragraph beside a list item, and items mixed with other blocks', () => {
    expect(reasonOf(() => apply('Ein Absatz.', { fromBlockId: 'itemaaaaaaa1' }))).toBe(
      'list_expects_items',
    );
    expect(reasonOf(() => apply('- drei\n\nAbsatz.', { fromBlockId: 'listaaaaaaaa' }))).toBe(
      'list_expects_items',
    );
  });

  it('still puts a paragraph beside a list when only a paragraph is sent', () => {
    const applied = apply('Nach der Liste.', { fromBlockId: 'listaaaaaaaa' });
    expect(topTypes(applied.proseMirrorJson)).toEqual([
      'paragraph',
      'bulletList',
      'paragraph',
      'paragraph',
      'bulletList',
      'taskList',
    ]);
  });

  it('still appends a continuation paragraph inside an item', () => {
    const applied = apply('Fortsetzung.', { fromBlockId: 'itemaaaaaaa1t' });
    const first = applied.proseMirrorJson.content?.[1]?.content?.[0] as ProseMirrorNode;
    expect(first.content?.map((node) => node.type)).toEqual(['paragraph', 'paragraph']);
  });
});

describe('deleting blocks (issue #247)', () => {
  it('removes an item, not just its text', () => {
    const applied = apply('', { fromBlockId: 'itemaaaaaaa1', placement: 'replace' });
    expect(itemTexts(applied.proseMirrorJson.content?.[1] as ProseMirrorNode)).toEqual(['zwei']);
    expect(serializeMarkdown(applied.proseMirrorJson)).not.toMatch(/^-\s*$/m);
  });

  it('removes the item when its only text is deleted', () => {
    const applied = apply('', { fromBlockId: 'itemaaaaaaa1t', placement: 'replace' });
    expect(itemTexts(applied.proseMirrorJson.content?.[1] as ProseMirrorNode)).toEqual(['zwei']);
  });

  it('removes the list with its last item, and the paragraphs around it stay', () => {
    const applied = apply('', { fromBlockId: 'itembbbbbbb1', placement: 'replace' });
    expect(topTypes(applied.proseMirrorJson)).toEqual([
      'paragraph',
      'bulletList',
      'paragraph',
      'taskList',
    ]);
  });

  it('removes a nested list with its last item and leaves the outer item standing', () => {
    const applied = apply('', { fromBlockId: 'subitemaaaa1', placement: 'replace' });
    const outer = applied.proseMirrorJson.content?.[1] as ProseMirrorNode;
    expect(outer.content?.[1]?.content?.map((node) => node.type)).toEqual(['paragraph']);
    expect(validateProseMirrorDocument(applied.proseMirrorJson).valid).toBe(true);
  });

  it('refuses to strip the text of an item that has sub-items, naming the item', () => {
    try {
      apply('', { fromBlockId: 'itemaaaaaaa2t', placement: 'replace' });
      expect.unreachable('an item without its text must be refused');
    } catch (error) {
      expect((error as BlockRangeError).reason).toBe('list_item_text');
      expect((error as BlockRangeError).blockId).toBe('itemaaaaaaa2');
    }
  });

  it('removes an empty paragraph instead of leaving a shell', () => {
    const page: ProseMirrorDocument = {
      type: 'doc',
      content: [
        text('vorheraaaaaa', 'Vorher.'),
        { type: 'paragraph', attrs: { [BLOCK_ID_ATTRIBUTE]: 'hulleaaaaaaa' } },
        text('nachheraaaaa', 'Nachher.'),
      ],
    };
    const applied = applyBlockRangeEditToState(
      proseMirrorJsonToYjsState(page),
      { type: 'doc', content: [] },
      { fromBlockId: 'hulleaaaaaaa', toBlockId: null, placement: 'replace' },
    );
    expect(
      (applied.proseMirrorJson.content ?? []).map((node) => node.attrs?.[BLOCK_ID_ATTRIBUTE]),
    ).toEqual(['vorheraaaaaa', 'nachheraaaaa']);
  });
});

describe('the same edit on a live document', () => {
  it('produces the same page as the stored one, so both sides agree (ADR-016)', () => {
    // The API edits the stored state; the collaboration server runs the same
    // function on the document people have open. Both must end up identical.
    const stored = apply('- drei', { fromBlockId: 'itemaaaaaaa2' });

    const live = yjsStateToDocument(proseMirrorJsonToYjsState(PAGE));
    const observed: number[] = [];
    live.on('update', () => observed.push(1));
    applyBlockRangeEditToYDoc(live, parseMarkdown('- drei').document, {
      fromBlockId: 'itemaaaaaaa2',
      toBlockId: null,
      placement: 'after',
    });
    const roundTrip = yjsStateToProseMirrorJson(Y.encodeStateAsUpdate(live));

    // One transaction, one update for a connected editor.
    expect(observed).toHaveLength(1);
    expect(serializeMarkdown(roundTrip)).toBe(serializeMarkdown(stored.proseMirrorJson));
    expect(itemTexts(roundTrip.content?.[1] as ProseMirrorNode)).toEqual(['eins', 'zwei', 'drei']);
    live.destroy();
  });
});
