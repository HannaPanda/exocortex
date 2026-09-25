import { type AiConversationMessage } from '@exocortex/contracts';

/**
 * What the AI panel shows, derived from its queries, the run in flight and the
 * page it stands on. Pure functions, split out of `ai-panel.tsx` (issue #97).
 */

/**
 * The assistant bubble for an answer that is still arriving, or `null` when
 * there is nothing in flight and nothing left over from one.
 */
export function buildStreamingMessage(input: {
  streamText: string;
  activeRunId: string | null;
  conversationId: string | null;
}): AiConversationMessage | null {
  if (input.streamText.length === 0 && input.activeRunId === null) return null;
  return {
    id: `streaming-${input.activeRunId ?? 'done'}`,
    conversationId: input.conversationId ?? '',
    role: 'assistant',
    content: input.streamText,
    toolName: null,
    toolCallId: null,
    isSummary: false,
    superseded: false,
    runId: input.activeRunId,
    createdAt: new Date().toISOString(),
  };
}

/**
 * The bubble for a slash command that answered with something to read, such as
 * `/help`, `/tools` or `/rules`. It is not a stored message, so it carries a
 * local id and belongs to no run.
 */
export function buildCommandNotice(conversationId: string, content: string): AiConversationMessage {
  return {
    id: `command-${Date.now().toString(36)}`,
    conversationId,
    role: 'system',
    content,
    toolName: null,
    toolCallId: null,
    isSummary: false,
    superseded: false,
    runId: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * What of the open page travels with the next message.
 *
 * Both parts are only trusted while they name the page the route is on: a
 * passage handed over from the editor would otherwise become an unlabelled
 * quote from somewhere else after navigating away, and a database view id left
 * over from the previous page would describe the wrong table.
 */
export function resolvePageHandover(input: {
  documentId: string | null;
  activeDatabaseView: { documentId: string; viewId: string } | null;
  handedOverSelection: { documentId: string; blockIds: string[]; text: string } | null;
}): {
  databaseViewId: string | null;
  selection: { blockIds: string[]; text: string } | null;
} {
  const { documentId, activeDatabaseView, handedOverSelection } = input;
  return {
    databaseViewId:
      activeDatabaseView?.documentId === documentId ? activeDatabaseView.viewId : null,
    selection: handedOverSelection?.documentId === documentId ? handedOverSelection : null,
  };
}

/**
 * What the transcript area is showing: a failure, a skeleton, the introduction,
 * or the conversation itself.
 *
 * A conversation that has not been opened yet is neither loading nor failed --
 * there is nothing to load -- which is why every state hangs off `open`.
 */
export function describeTranscript(input: {
  open: boolean;
  query: { pending: boolean; errored: boolean };
  messageCount: number;
  commandNotice: AiConversationMessage | null;
  streamingMessage: AiConversationMessage | null;
}): { loading: boolean; errored: boolean; showIntro: boolean } {
  const loading = input.open && input.query.pending;
  const errored = input.open && input.query.errored;
  const empty =
    input.messageCount === 0 && input.commandNotice === null && input.streamingMessage === null;
  return { loading, errored, showIntro: !loading && !errored && empty };
}
