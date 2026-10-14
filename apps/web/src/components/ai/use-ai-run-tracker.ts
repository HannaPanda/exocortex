import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  advanceAiRunSequence,
  type AiConversationMessage,
  type AiRun,
  type AiRunPhase,
  type AiRunStatus,
  INITIAL_AI_RUN_SEQUENCE_STATE,
  isAiRunQuiet,
  reconcileAiRun,
  resolveAiRunElapsedMs,
} from '@exocortex/contracts';
import { aiRunDiagnosisText } from '@exocortex/i18n';

import { aiQueryKeys, useAiRun, useCancelAiRun } from '@/lib/api/ai-queries';
import { ApiError } from '@/lib/api/client';
import { useRealtime, useRealtimeEvent } from '@/lib/realtime/realtime-provider';

import {
  appendReasoning,
  appendToolEvent,
  type FinishedRunTrace,
  type RunTraceStep,
  toolEntries,
} from './run-trace';

/** One line of "what the model just did", as the panel renders it. */
export interface ToolActivityEntry {
  key: string;
  toolName: string;
  /**
   * `refused` means the trust boundary declined the call; nothing ran (issue #56).
   * `retried` is no tool at all: the provider's answer came back empty and the
   * worker asked for the same turn again. It stands in this list because it is
   * one more thing the run did, and the reader wants it in order with the rest.
   */
  status: 'started' | 'succeeded' | 'failed' | 'refused' | 'retried';
  /** Compact identifier of what the call touched, e.g. `document:<id>`. */
  target: string | null;
}

/**
 * Reasons a run can fail that the user can actually do something about; each
 * one's sentence is `ai.run.errors.<code>`. Codes outside this list keep the
 * generic message. `ai_cancelled` is deliberately absent: a user-triggered
 * cancellation is shown as a neutral notice, not an error (see
 * `applyTerminalRunState`).
 */
const EXPLAINED_RUN_ERRORS = [
  'ai_response_truncated',
  'ai_tool_limit_exceeded',
  'ai_tool_call_invalid',
  'ai_budget_exceeded',
  'ai_timeout',
  'ai_stream_interrupted',
  'ai_empty_answer',
] as const;
type ExplainedRunError = (typeof EXPLAINED_RUN_ERRORS)[number];

function isExplainedRunError(code: string | null): code is ExplainedRunError {
  return EXPLAINED_RUN_ERRORS.some((known) => known === code);
}

/** A failed run's diagnosis, whether the poll or the socket reported it (issue #98). */
interface RunDiagnosisFields {
  errorDetail: string | null;
  errorDetailKey: string | null;
  errorDetailArgs: unknown;
}

/**
 * The sentence for a run that ended without an answer: its own diagnosis
 * when it has one (issue #118), rendered from its key in the viewer's
 * language and from the stored German only for a key this build does not
 * know (issue #98); the canned sentence for its code otherwise.
 */
export function runFailureText(
  t: (key: `errors.${ExplainedRunError}` | 'failed') => string,
  tDiagnostics: Parameters<typeof aiRunDiagnosisText>[0],
  errorCode: string | null,
  diagnosis: RunDiagnosisFields,
): string {
  const detail = aiRunDiagnosisText(tDiagnostics, diagnosis);
  return detail ?? (isExplainedRunError(errorCode) ? t(`errors.${errorCode}`) : t('failed'));
}

/** A retried turn becomes a line of its own, in order with the tool calls around it. */
function withRetryLine(current: RunTraceStep[], phase: AiRunPhase): RunTraceStep[] {
  if (phase !== 'retrying') return current;
  return appendToolEvent(current, -1, { toolName: '', status: 'retried', target: null });
}

/**
 * How the conversation's newest run ended, when it ended without an answer,
 * read from the server rather than remembered by this tab: a failure the
 * socket reported is gone after a reload, and one that happened while nobody
 * was watching was never reported here at all. `null` while something
 * fresher (a run in flight, this tab's own error) stands in its place.
 */
export function useLastRunFailure(lastRun: AiRun | null, superseded: boolean): string | null {
  const t = useTranslations('ai.run');
  const tDiagnostics = useTranslations('diagnostics');
  if (superseded || lastRun === null) return null;
  if (lastRun.status !== 'failed' && lastRun.status !== 'timed_out') return null;
  return runFailureText(t, tDiagnostics, lastRun.errorCode, lastRun);
}

/**
 * The realtime events that make up a run's trace (issue #195): its phases,
 * its thinking and its tool calls, folded into one ordered list.
 */
function useRunTraceEvents(
  activeRunId: string | null,
  setRunPhase: (phase: AiRunPhase) => void,
  setTrace: React.Dispatch<React.SetStateAction<RunTraceStep[]>>,
  markActivity: () => void,
): void {
  // The silence gets a name (issue #6, point 5): reasoning produces no deltas
  // at all, and compaction used to report itself only once it was over.
  useRealtimeEvent('ai.run.phase', (event) => {
    if (event.payload.runId !== activeRunId) return;
    setRunPhase(event.payload.phase);
    markActivity();
    setTrace((current) => withRetryLine(current, event.payload.phase));
  });

  // Only ever reaches the person who started the run (ADR-087), and is not
  // stored anywhere: a reload or a dropped frame loses it, which is why gaps
  // in its sequence are not repaired the way the answer's are.
  useRealtimeEvent('ai.run.reasoning', (event) => {
    if (event.payload.runId !== activeRunId) return;
    setTrace((current) => appendReasoning(current, event.payload.turn, event.payload.delta));
    markActivity();
  });

  useRealtimeEvent('ai.run.tool_call', (event) => {
    if (event.payload.runId !== activeRunId) return;
    setTrace((current) =>
      appendToolEvent(current, event.payload.iteration, {
        toolName: event.payload.toolName,
        status: event.payload.status,
        target: event.payload.target,
      }),
    );
    markActivity();
  });
}

const NO_DIAGNOSIS: RunDiagnosisFields = {
  errorDetail: null,
  errorDetailKey: null,
  errorDetailArgs: null,
};

/** What `AiPanel` reads back from the tracker. */
export interface AiRunTracker {
  activeRunId: string | null;
  streamText: string;
  toolActivity: ToolActivityEntry[];
  /** What the run in flight did so far, thinking and tool calls in order (issue #195). */
  trace: RunTraceStep[];
  /** The trace of the run that ended last in this conversation, until the next one starts. */
  finishedTrace: FinishedRunTrace | null;
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
  const t = useTranslations('ai.run');
  const tDiagnostics = useTranslations('diagnostics');
  const queryClient = useQueryClient();

  const [activeRunId, setActiveRunId] = React.useState<string | null>(null);
  const [streamText, setStreamText] = React.useState('');
  const [trace, setTrace] = React.useState<RunTraceStep[]>([]);
  const [finishedTrace, setFinishedTrace] = React.useState<FinishedRunTrace | null>(null);
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
    setTrace([]);
    setFinishedTrace(null);
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
    (status: AiRunStatus, errorCode: string | null, diagnosis: RunDiagnosisFields): void => {
      // The trace outlives the run, folded, beside the answer it led to: the
      // thinking is not stored anywhere, so this is the last chance to read it.
      if (activeRunId !== null) setFinishedTrace({ runId: activeRunId, steps: trace });
      setActiveRunId(null);
      setTrace([]);
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
        setNotice(t('cancelled'));
        return;
      }
      // The run's own diagnosis wins over the canned sentence when it has one
      // (issue #118): "zu viele Werkzeugaufrufe" is the fact the reader
      // already had, and what the run did with those calls is the part that
      // says what to try instead.
      setError(runFailureText(t, tDiagnostics, errorCode, diagnosis));
    },
    [activeConversationId, activeRunId, trace, queryClient, t, tDiagnostics],
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
    applyTerminalRunState(reconciliation.status, reconciliation.errorCode, reconciliation);
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

  useRunTraceEvents(activeRunId, setRunPhase, setTrace, () => setLastActivityAt(Date.now()));

  useRealtimeEvent('ai.run.completed', (event) => {
    if (event.payload.runId !== activeRunId) return;
    applyTerminalRunState('completed', null, NO_DIAGNOSIS);
  });

  useRealtimeEvent('ai.run.failed', (event) => {
    if (event.payload.runId !== activeRunId) return;
    applyTerminalRunState(event.payload.status, event.payload.errorCode, {
      errorDetail: event.payload.detail,
      errorDetailKey: event.payload.detailKey,
      errorDetailArgs: event.payload.detailArgs,
    });
  });

  useRealtimeEvent('ai.conversation.compacted', (event) => {
    if (event.payload.conversationId !== activeConversationId) return;
    setNotice(t('compacted'));
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
  const toolActivity = React.useMemo(() => toolEntries(trace), [trace]);

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
    // oxlint-disable-next-line react/exhaustive-deps
  }, [gapDetected, activeRunId]);

  const handleCancelRun = async (): Promise<void> => {
    if (activeRunId === null) return;
    const runId = activeRunId;
    try {
      await cancelRun.mutateAsync(runId);
      applyTerminalRunState('cancelled', null, NO_DIAGNOSIS);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        // The run finished by itself just before the cancellation reached the
        // server; let the next poll (or the socket) reconcile the real
        // outcome instead of reporting a cancellation that never happened.
        void runQuery.refetch();
        return;
      }
      setError(caught instanceof ApiError ? caught.message : t('cancelFailed'));
    }
  };
  /** Starts tracking a run the panel just created. */
  const beginRun = (runId: string): void => {
    setStreamText('');
    setTrace([]);
    setFinishedTrace(null);
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
    trace,
    finishedTrace,
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
