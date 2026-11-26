import { type AiConversationMessage } from '@exocortex/contracts';

import { type FinishedRunTrace, type RunTraceStep } from './run-trace';
import { pendingSegments, type StreamSegments } from './stream-segments';
import { type TranscriptTrace } from './transcript';

/**
 * What the AI panel shows, derived from its queries, the run in flight and the
 * page it stands on. Pure functions, split out of `ai-panel.tsx` (issue #97).
 */

/**
 * The assistant bubbles for a run whose text the transcript does not carry
 * yet, one per turn that wrote (issue #242), or none when nothing is in
 * flight and nothing is left over from one. While the run is live the last
 * one is the turn being written, empty until its first fragment arrives,
 * because that is where the cursor belongs.
 *
 * They carry no `runId`: the link to the run belongs to the stored answer,
 * which takes their place.
 */
export function buildStreamingMessages(input: {
  stream: StreamSegments;
  messages: readonly AiConversationMessage[];
  activeRunId: string | null;
  conversationId: string | null;
}): AiConversationMessage[] {
  const { stream, activeRunId } = input;
  if (stream.runId === null) return [];
  const live = activeRunId !== null && activeRunId === stream.runId;
  const stored = input.messages
    .filter(
      (message) =>
        message.role === 'assistant' &&
        message.runId === stream.runId &&
        message.content.trim().length > 0,
    )
    .map((message) => message.content);
  return pendingSegments(stream, stored, live).map(({ index, text }) => ({
    id: `streaming-${stream.runId ?? 'done'}-${String(index)}`,
    conversationId: input.conversationId ?? '',
    role: 'assistant',
    content: text,
    toolName: null,
    toolCallId: null,
    isSummary: false,
    superseded: false,
    runId: null,
    createdAt: new Date().toISOString(),
  }));
}

/**
 * The one trace the transcript shows (issue #195): the run in flight, or the
 * one that ended last. Live or over, it is the same element, so it folds where
 * it stands instead of being drawn anew (issue #242).
 */
export function resolveTranscriptTrace(input: {
  activeRunId: string | null;
  steps: readonly RunTraceStep[];
  finished: FinishedRunTrace | null;
}): TranscriptTrace | null {
  if (input.activeRunId !== null) {
    return { runId: input.activeRunId, steps: input.steps, live: true };
  }
  if (input.finished === null) return null;
  return { runId: input.finished.runId, steps: input.finished.steps, live: false };
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
  streamingCount: number;
}): { loading: boolean; errored: boolean; showIntro: boolean } {
  const loading = input.open && input.query.pending;
  const errored = input.open && input.query.errored;
  const empty =
    input.messageCount === 0 && input.commandNotice === null && input.streamingCount === 0;
  return { loading, errored, showIntro: !loading && !errored && empty };
}
