import { type EditorState } from '@tiptap/pm/state';

import { type CollaborationEditNotice, collaborationEditNoticeSchema } from '@exocortex/contracts';
import { BLOCK_ID_ATTRIBUTE, isValidBlockId } from '@exocortex/editor';

/**
 * The decisions behind the agent edit markers (issue #112), apart from the
 * drawing, so they can be tested without a browser. See
 * `agent-edit-markers.tsx` for what the states mean.
 */

export type AgentEditState = 'changed' | 'conflict' | 'failed';

/** A stateless payload, if it is an edit notice; anything else is not ours. */
export function readEditNotice(payload: string): CollaborationEditNotice | null {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = collaborationEditNoticeSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Identifiers of every block the cursor stands in, from the innermost outward. */
export function blocksAtSelection(state: EditorState): Set<string> {
  const ids = new Set<string>();
  for (const resolved of [state.selection.$from, state.selection.$to]) {
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      const id: unknown = resolved.node(depth).attrs[BLOCK_ID_ATTRIBUTE];
      if (isValidBlockId(id)) ids.add(id);
    }
  }
  return ids;
}

/**
 * The state each named block is marked with. A change inside a block the
 * reader is typing in is a conflict; `underCursor` is empty when they are not
 * typing, which is the caller's judgement, not this function's.
 */
export function markerStates(
  notice: CollaborationEditNotice,
  underCursor: ReadonlySet<string>,
): Map<string, AgentEditState> {
  const states = new Map<string, AgentEditState>();
  for (const id of notice.blockIds) {
    states.set(
      id,
      notice.outcome === 'failed' ? 'failed' : underCursor.has(id) ? 'conflict' : 'changed',
    );
  }
  return states;
}
