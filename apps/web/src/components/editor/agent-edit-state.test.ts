import { EditorState, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import {
  type AiRunChangedBlock,
  type CollaborationEditNotice,
  EDIT_NOTICE_TYPE,
} from '@exocortex/contracts';
import { BLOCK_ID_ATTRIBUTE, getExocortexSchema } from '@exocortex/editor';

import {
  blocksAtSelection,
  markerStates,
  readEditNotice,
  runHighlightEntries,
} from './agent-edit-state';

const schema = getExocortexSchema();

function notice(overrides: Partial<CollaborationEditNotice> = {}): CollaborationEditNotice {
  return {
    type: EDIT_NOTICE_TYPE,
    outcome: 'changed',
    actorKind: 'agent',
    actorName: 'claude-code',
    blockIds: ['paraaaaaaaa1', 'paraaaaaaaa2'],
    ...overrides,
  };
}

/** A list with one item and a paragraph after it, cursor inside the item. */
function stateWithCursorInListItem(): EditorState {
  const paragraph = (id: string, text: string) =>
    schema.node('paragraph', { [BLOCK_ID_ATTRIBUTE]: id }, schema.text(text));
  const doc = schema.node('doc', null, [
    schema.node('bulletList', { [BLOCK_ID_ATTRIBUTE]: 'listaaaaaaa1' }, [
      schema.node('listItem', { [BLOCK_ID_ATTRIBUTE]: 'itemaaaaaaa1' }, [
        paragraph('itemparaaaa1', 'Milch'),
      ]),
    ]),
    paragraph('paraaaaaaaa9', 'Danach'),
  ]);
  const state = EditorState.create({ schema, doc });
  // Position 4 is inside "Milch": doc > bulletList > listItem > paragraph.
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 4)));
}

describe('readEditNotice', () => {
  it('reads a notice the collaboration server sent', () => {
    expect(readEditNotice(JSON.stringify(notice()))).toEqual(notice());
  });

  it('ignores anything else that travels as a stateless message', () => {
    expect(readEditNotice('not json')).toBeNull();
    expect(readEditNotice(JSON.stringify({ type: 'something-else' }))).toBeNull();
  });
});

describe('blocksAtSelection', () => {
  it('names every block around the cursor, innermost first, and nothing beside it', () => {
    expect([...blocksAtSelection(stateWithCursorInListItem())]).toEqual([
      'itemparaaaa1',
      'itemaaaaaaa1',
      'listaaaaaaa1',
    ]);
  });
});

describe('markerStates', () => {
  it('marks a change as a change while the reader is elsewhere', () => {
    expect(markerStates(notice(), new Set())).toEqual(
      new Map([
        ['paraaaaaaaa1', 'changed'],
        ['paraaaaaaaa2', 'changed'],
      ]),
    );
  });

  it('marks a conflict only in the block the reader is typing in', () => {
    expect(markerStates(notice(), new Set(['paraaaaaaaa2']))).toEqual(
      new Map([
        ['paraaaaaaaa1', 'changed'],
        ['paraaaaaaaa2', 'conflict'],
      ]),
    );
  });

  it('marks a refusal as a refusal, wherever the cursor is', () => {
    expect(
      markerStates(
        notice({ outcome: 'failed', blockIds: ['paraaaaaaaa1'] }),
        new Set(['paraaaaaaaa1']),
      ),
    ).toEqual(new Map([['paraaaaaaaa1', 'failed']]));
  });
});

describe('runHighlightEntries', () => {
  const block = (overrides: Partial<AiRunChangedBlock>): AiRunChangedBlock => ({
    blockId: 'b',
    group: 0,
    change: 'changed',
    state: 'revertible',
    nodeType: 'paragraph',
    excerpt: null,
    standing: [],
    ...overrides,
  });

  it('marks what the run left as changed and what somebody changed since as a conflict', () => {
    expect(
      runHighlightEntries([
        block({ blockId: 'a' }),
        block({ blockId: 'b', change: 'added', state: 'changed_since' }),
      ]),
    ).toEqual([
      { id: 'a', state: 'changed' },
      { id: 'b', state: 'conflict' },
    ]);
  });

  it('marks a rewrite under a new identifier as the conflict it is', () => {
    expect(
      runHighlightEntries([
        block({
          blockId: 'a',
          change: 'added',
          state: 'changed_since',
          standing: [{ blockId: 'c', nodeType: 'paragraph', excerpt: 'Neu' }],
        }),
      ]),
    ).toEqual([
      { id: 'a', state: 'conflict' },
      { id: 'c', state: 'conflict' },
    ]);
  });

  it('marks nothing for a block that is gone or already back', () => {
    expect(
      runHighlightEntries([
        block({ blockId: 'a', change: 'removed' }),
        block({ blockId: 'b', state: 'reverted' }),
      ]),
    ).toEqual([]);
  });
});
