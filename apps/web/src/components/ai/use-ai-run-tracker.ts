import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import {
  advanceAiRunSequence,
  type AiConversationMessage,
  type AiRunPhase,
  type AiRunStatus,
  INITIAL_AI_RUN_SEQUENCE_STATE,
  isAiRunQuiet,
  reconcileAiRun,
  resolveAiRunElapsedMs,
} from '@exocortex/contracts';

import { aiQueryKeys, useAiRun, useCancelAiRun } from '@/lib/api/ai-queries';
import { ApiError } from '@/lib/api/client';
import { useRealtime, useRealtimeEvent } from '@/lib/realtime/realtime-provider';

/** One line of "what the model just did", as the panel renders it. */
export interface ToolActivityEntry {
  key: string;
  toolName: string;
  status: 'started' | 'succeeded' | 'failed';
  /** Compact identifier of what the call touched, e.g. `document:<id>`. */
  target: string | null;
}

/**
 * Reasons a run can fail that the user can actually do something about. Codes
 * outside this map keep the generic message. `ai_cancelled` is deliberately
 * absent: a user-triggered cancellation is shown as a neutral notice, not an
 * error (see `applyTerminalRunState`).
 */
const RUN_ERROR_MESSAGES: Record<string, string> = {
  ai_response_truncated:
    'Die Antwort wurde am Ausgabelimit abgeschnitten. Frage nach einem kleineren Schritt, ' +
    'oder erhöhe „Maximale Antwortlänge (Tokens)“ in der Verwaltung.',
  ai_tool_limit_exceeded: 'Die KI hat zu viele Werkzeugaufrufe gebraucht.',
  ai_tool_call_invalid: 'Ein Werkzeugaufruf kam unvollständig an und wurde nicht ausgeführt.',
  ai_budget_exceeded: 'Die Antwort hätte das Kostenlimit dieses Laufs überschritten.',
  ai_timeout: 'Die KI hat zu lange gebraucht.',
};

/** What `AiPanel` reads back from the tracker. */
export interface AiRunTracker {
  activeRunId: string | null;
  streamText: string;
  toolActivity: ToolActivityEntry[];
  runPhase: AiRunPhase | null;
  elapsedMs: number;
  runQuiet: boolean;
  gapDetected: boolean;
  notice: string | null;
  setNotice: (value: string | null) => void;
  error: string | null;
  setError: (value: string | null) => void;
  commandNotice: AiConversationMessage | null;
  setCommandNotice: (value: AiConversationMessage | null) => void;
  beginRun: (runId: string) => void;
  cancel: () => Promise<void>;
  cancelling: boolean;
}

/**
 * Everything about the run that is in flight right now.
 *
 * Split out of `AiPanel` because it is a state machine, not a rendering
 * concern: ten pieces of state, six realtime subscriptions, a poll that
 * reconciles whatever the socket dropped, and the repair path for a gap in the
 * delta sequence. The panel only needs to know what to show.
 */
export function useAiRunTracker(activeConversationId: string | null): AiRunTracker {
  const queryClient = useQueryClient();

  const [activeRunId, setActiveRunId] = React.useState<string | null>(null);
  const [streamText, setStreamText] = React.useState('');
  const [toolActivity, setToolActivity] = React.useState<ToolActivityEntry[]>([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // A single slot, not a list: a command's answer replaces the previous one
  // instead of piling up below the transcript (issue #25). Only the commands
  // that answer with a list (`/help`, `/tools`, `/rules`) land here; a one-line
  // confirmation goes into `notice`, and `/clear` needs neither, because the
  // boundary drawn in the transcript is its answer.
  const [commandNotice, setCommandNotice] = React.useState<AiConversationMessage | null>(null);

  // Life-sign tracking for the run's pulse (issue #6): when it started, and
  // the last time any signal (a delta, a tool-call event) arrived.
  const [runStartedAt, setRunStartedAt] = React.useState<number | null>(null);
  const [lastActivityAt, setLastActivityAt] = React.useState<number | null>(null);
  // `ai.run.progress`'s monotonic `sequence`, and whether a gap in it was ever
  // seen. Both fields are updated together (a functional `useState` updater,
  // not a ref) so a burst of events arriving before a render commits can never
  // compare against a stale `expected` value.
  const [sequenceState, setSequenceState] = React.useState(INITIAL_AI_RUN_SEQUENCE_STATE);
  // What the worker last said it is busy with. Null until it says anything.
  const [runPhase, setRunPhase] = React.useState<AiRunPhase | null>(null);
  const cancelRun = useCancelAiRun();

  // Switching conversations must not carry the previous one's transient state
  // along. Adjusted during render (React's documented pattern for resetting
  // state when a value changes) rather than in an effect, so there is no extra
  // committed render with stale state in between.
  const [transientStateKey, setTransientStateKey] = React.useState(activeConversationId);
  if (transientStateKey !== activeConversationId) {
    setTransientStateKey(activeConversationId);
    setActiveRunId(null);
    setStreamText('');
    setToolActivity([]);
    setNotice(null);
    setError(null);
    setCommandNotice(null);
    setRunStartedAt(null);
    setLastActivityAt(null);
    setSequenceState(INITIAL_AI_RUN_SEQUENCE_STATE);
    setRunPhase(null);
  }

  // The run's own status, polled independently of the realtime channel
  // (issue #6, point 1). This is the safety net for every event the socket
  // ever drops: a reconnect, a backgrounded tab, a cancellation the worker
  // only learns about later. `applyTerminalRunState` below is the single
  // place that reacts to a run ending, whichever way it finds out.
  const runQuery = useAiRun(activeRunId);

  const applyTerminalRunState = React.useCallback(
    (status: AiRunStatus, errorCode: string | null): void => {
      setActiveRunId(null);
      setToolActivity([]);
      setRunStartedAt(null);
      setLastActivityAt(null);
      setSequenceState(INITIAL_AI_RUN_SEQUENCE_STATE);
      setRunPhase(null);
      if (status === 'completed') {
        // Keep the streaming bubble on screen (its content is already final)
        // until the refetched conversation carries the persisted message, so
        // nothing flickers or disappears in between.
        if (activeConversationId !== null) {
          void queryClient
            .invalidateQueries({ queryKey: aiQueryKeys.conversation(activeConversationId) })
            .then(() => setStreamText(''));
        } else {
          setStreamText('');
        }
        return;
      }
      setStreamText('');
      if (status === 'cancelled') {
        setNotice('Lauf abgebrochen.');
        return;
      }
      setError(
        RUN_ERROR_MESSAGES[errorCode ?? ''] ?? 'Die KI-Antwort konnte nicht erzeugt werden.',
      );
    },
    [activeConversationId, queryClient],
  );

  // Applies a terminal status the poll (or a focus/reconnect refetch)
  // revealed before any socket event reported it. Adjusted during render --
  // the same idiom as the conversation-switch reset above -- guarded by
  // `reconciledRunResultKey` so it fires exactly once per run outcome rather
  // than on every render the ticking clock below causes.
  const [reconciledRunResultKey, setReconciledRunResultKey] = React.useState<string | null>(null);
  const reconciliation = reconcileAiRun({
    activeRunId,
    run: runQuery.data ?? null,
    appliedKey: reconciledRunResultKey,
  });
  if (reconciliation !== null) {
    setReconciledRunResultKey(reconciliation.key);
    applyTerminalRunState(reconciliation.status, reconciliation.errorCode);
  }

  // The other half of "abgleichen statt nur zuzuhören": a reconnect of the
  // realtime socket itself (not just the browser regaining focus, which
  // `useAiRun`'s `refetchOnWindowFocus` already covers) refetches the run
  // immediately rather than waiting out the poll interval.
  const { status: realtimeStatus } = useRealtime();
  const previousRealtimeStatusRef = React.useRef(realtimeStatus);
  React.useEffect(() => {
    const reconnected =
      previousRealtimeStatusRef.current !== 'connected' && realtimeStatus === 'connected';
    previousRealtimeStatusRef.current = realtimeStatus;
    if (reconnected && activeRunId !== null) void runQuery.refetch();
  }, [realtimeStatus, activeRunId, runQuery]);

  // A ticking clock, captured as state rather than read via `Date.now()`
  // directly in the render body, so the elapsed-time display in
  // `RunActivity` keeps moving once a second while a run is active.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (activeRunId === null) return;
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [activeRunId]);

  useRealtimeEvent('ai.run.progress', (event) => {
    if (event.payload.runId !== activeRunId) return;
    setSequenceState((current) => advanceAiRunSequence(current, event.payload.sequence));
    setStreamText((current) => current + event.payload.delta);
    // Text arriving is itself the end of any named silence before it.
    setRunPhase('generating');
    setLastActivityAt(Date.now());
  });

  // The silence gets a name (issue #6, point 5): reasoning produces no deltas
  // at all, and compaction used to report itself only once it was over.
  useRealtimeEvent('ai.run.phase', (event) => {
    if (event.payload.runId !== activeRunId) return;
    setRunPhase(event.payload.phase);
    setLastActivityAt(Date.now());
  });

  useRealtimeEvent('ai.run.tool_call', (event) => {
    if (event.payload.runId !== activeRunId) return;
    setToolActivity((current) => [
      ...current,
      {
        key: `${event.payload.iteration}:${event.payload.toolName}:${event.payload.status}`,
        toolName: event.payload.toolName,
        status: event.payload.status,
        target: event.payload.target,
      },
    ]);
    setLastActivityAt(Date.now());
  });

  useRealtimeEvent('ai.run.completed', (event) => {
    if (event.payload.runId !== activeRunId) return;
    applyTerminalRunState('completed', null);
  });

  useRealtimeEvent('ai.run.failed', (event) => {
    if (event.payload.runId !== activeRunId) return;
    applyTerminalRunState(event.payload.status, event.payload.errorCode);
  });

  useRealtimeEvent('ai.conversation.compacted', (event) => {
    if (event.payload.conversationId !== activeConversationId) return;
    setNotice('Älterer Verlauf wurde zusammengefasst.');
    void queryClient.invalidateQueries({
      queryKey: aiQueryKeys.conversation(event.payload.conversationId),
    });
  });

  // Elapsed time counts from the latest confirmed sign of life: the run's
  // own start, the last realtime event this panel received, or -- covering a
  // dropped socket entirely -- the worker's own heartbeat as last observed by
  // the poll above. Whichever is most recent wins, so a live heartbeat keeps
  // the clock honest even if every event this tab would have received was
  // lost.
  const heartbeatAtMs =
    runQuery.data?.id === activeRunId && runQuery.data.heartbeatAt !== null
      ? new Date(runQuery.data.heartbeatAt).getTime()
      : null;
  const elapsedMs =
    activeRunId === null
      ? 0
      : resolveAiRunElapsedMs({
          startedAtMs: runStartedAt,
          lastEventAtMs: lastActivityAt,
          heartbeatAtMs,
          nowMs: now,
        });
  const runQuiet = isAiRunQuiet(elapsedMs);

  // A gap in `ai.run.progress` means the locally stitched preview is missing
  // something, and no amount of further deltas repairs it. So the answer is
  // reloaded from the run itself, which the worker keeps current with every
  // heartbeat, instead of quietly showing an incomplete text (issue #6,
  // point 6). Repeated on every poll for as long as the gap flag stands, so
  // the preview keeps catching up while the run continues.
  const [repairedTextKey, setRepairedTextKey] = React.useState<string | null>(null);
  const repairKey =
    sequenceState.gap && activeRunId !== null && runQuery.data?.id === activeRunId
      ? `${activeRunId}:${String(runQuery.dataUpdatedAt)}`
      : null;
  if (repairKey !== null && repairKey !== repairedTextKey) {
    setRepairedTextKey(repairKey);
    setStreamText(runQuery.data?.resultText ?? '');
  }

  // ... and ask for it right away rather than waiting out the poll interval.
  const gapDetected = sequenceState.gap;
  React.useEffect(() => {
    if (gapDetected && activeRunId !== null) void runQuery.refetch();
    // `runQuery` is deliberately not a dependency: including it would refetch
    // on every poll result, not on the gap being noticed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gapDetected, activeRunId]);

  const handleCancelRun = async (): Promise<void> => {
    if (activeRunId === null) return;
    const runId = activeRunId;
    try {
      await cancelRun.mutateAsync(runId);
      applyTerminalRunState('cancelled', null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        // The run finished by itself just before the cancellation reached the
        // server; let the next poll (or the socket) reconcile the real
        // outcome instead of reporting a cancellation that never happened.
        void runQuery.refetch();
        return;
      }
      setError(
        caught instanceof ApiError ? caught.message : 'Der Lauf konnte nicht abgebrochen werden.',
      );
    }
  };
  /** Starts tracking a run the panel just created. */
  const beginRun = (runId: string): void => {
    setStreamText('');
    setToolActivity([]);
    setSequenceState(INITIAL_AI_RUN_SEQUENCE_STATE);
    setRunPhase(null);
    const startedAt = Date.now();
    setRunStartedAt(startedAt);
    setLastActivityAt(startedAt);
    setActiveRunId(runId);
  };

  return {
    activeRunId,
    streamText,
    toolActivity,
    runPhase,
    elapsedMs,
    runQuiet,
    gapDetected,
    notice,
    setNotice,
    error,
    setError,
    commandNotice,
    setCommandNotice,
    beginRun,
    cancel: handleCancelRun,
    cancelling: cancelRun.isPending,
  };
}
