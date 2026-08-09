'use client';

import { useQueryClient } from '@tanstack/react-query';
import { PlusIcon, SparklesIcon } from 'lucide-react';
import * as React from 'react';

import {
  advanceAiRunSequence,
  type AiConversationMessage,
  type AiReasoningLevel,
  type AiRunPhase,
  type AiRunStatus,
  INITIAL_AI_RUN_SEQUENCE_STATE,
  isAiRunQuiet,
  reconcileAiRun,
  resolveAiRunElapsedMs,
} from '@exocortex/contracts';
import {
  Button,
  ErrorState,
  LoadingState,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { useDocumentSession } from '@/components/shell/document-session';
import {
  aiQueryKeys,
  useAiConversation,
  useAiModels,
  useAiRun,
  useCancelAiRun,
  useCreateAiConversation,
  usePostConversationMessage,
  useUpdateAiConversation,
} from '@/lib/api/ai-queries';
import { ApiError } from '@/lib/api/client';
import { useDocument } from '@/lib/api/queries';
import { useRealtime, useRealtimeEvent } from '@/lib/realtime/realtime-provider';
import { usePersistentState } from '@/lib/use-persistent-state';

import { useAiSelection } from './ai-selection';
import { ChatComposer } from './chat-composer';
import { ChatMessage } from './chat-message';
import { ContextChips } from './context-chips';
import { ContextMeter } from './context-meter';
import { ConversationSwitcher } from './conversation-switcher';
import { ModelPicker } from './model-picker';
import { RunActivity } from './run-activity';

export interface AiPanelProps {
  workspaceId: string | null;
  documentId: string | null;
}

interface ToolActivityEntry {
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

function parseConversationId(raw: string): string | null {
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'string' ? parsed : null;
}

/** Turns a tool's compact target (`document:<id>`, `workspace:<id>`) into a short German phrase. */
function describeToolTarget(target: string | null): string | null {
  if (target === null) return null;
  const separatorIndex = target.indexOf(':');
  if (separatorIndex === -1) return target;
  const kind = target.slice(0, separatorIndex);
  const id = target.slice(separatorIndex + 1);
  const label = kind === 'document' ? 'Seite' : kind === 'workspace' ? 'Workspace' : kind;
  return `${label} ${id}`;
}

function toolActivityLine(entry: ToolActivityEntry): string {
  const suffix =
    entry.status === 'started'
      ? 'wird ausgeführt …'
      : entry.status === 'succeeded'
        ? '… fertig'
        : '… fehlgeschlagen';
  const targetLabel = describeToolTarget(entry.target);
  const targetSuffix = targetLabel === null ? '' : ` (${targetLabel})`;
  return `Werkzeug ${entry.toolName}${targetSuffix} ${suffix}`;
}

/**
 * Phase shown in the run's pulse while it is active.
 *
 * A tool in flight wins, because it is the most concrete thing to say. After
 * that comes whatever the worker last reported about itself: thinking and
 * compaction produce no text at all, and being able to name them is the
 * difference between a legitimate silence and a run that looks dead
 * (issue #6).
 */
function currentPhaseLabel(
  toolActivity: readonly ToolActivityEntry[],
  streamText: string,
  phase: AiRunPhase | null,
): string {
  const last = toolActivity[toolActivity.length - 1];
  if (last !== undefined && last.status === 'started') {
    const targetLabel = describeToolTarget(last.target);
    return `Werkzeug ${last.toolName}${targetLabel === null ? '' : ` (${targetLabel})`} wird ausgeführt`;
  }
  if (phase === 'reasoning') return 'KI denkt nach';
  if (phase === 'compacting') return 'Älterer Verlauf wird zusammengefasst';
  return streamText.length > 0 ? 'Antwort wird geschrieben' : 'Antwort wird erzeugt';
}

/**
 * AI side panel.
 *
 * Server state (models, conversations, messages) lives entirely in TanStack
 * Query; the only local state is the in-flight streaming assistant buffer,
 * transient tool-activity lines and ephemeral slash-command notices. This is
 * the deliberate difference from the previous version, which mirrored the
 * transcript into a local array and lost it on every reload.
 */
export function AiPanel({ workspaceId, documentId }: AiPanelProps) {
  const [activeConversationId, setActiveConversationId] = usePersistentState<string | null>(
    `exocortex.ai.conversation.${workspaceId ?? 'none'}`,
    null,
    parseConversationId,
  );

  const modelsQuery = useAiModels();
  const conversationQuery = useAiConversation(activeConversationId);
  const createConversation = useCreateAiConversation();
  const updateConversation = useUpdateAiConversation();
  const postMessage = usePostConversationMessage();
  const queryClient = useQueryClient();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const [pendingModelSlug, setPendingModelSlug] = React.useState<string | null>(null);
  const [pendingReasoningLevel, setPendingReasoningLevel] = React.useState<AiReasoningLevel | null>(
    null,
  );
  // Mirrors `pendingModelSlug`: the chip is operable before the first message,
  // when there is no conversation row to write the choice to yet. It travels
  // along in the create request.
  const [pendingPageContextEnabled, setPendingPageContextEnabled] = React.useState<boolean | null>(
    null,
  );
  const [activeRunId, setActiveRunId] = React.useState<string | null>(null);
  const [streamText, setStreamText] = React.useState('');
  const [toolActivity, setToolActivity] = React.useState<ToolActivityEntry[]>([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [commandNotices, setCommandNotices] = React.useState<AiConversationMessage[]>([]);

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
    setCommandNotices([]);
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
      setError(RUN_ERROR_MESSAGES[errorCode ?? ''] ?? 'Die KI-Antwort konnte nicht erzeugt werden.');
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
    const reconnected = previousRealtimeStatusRef.current !== 'connected' && realtimeStatus === 'connected';
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
      setError(caught instanceof ApiError ? caught.message : 'Der Lauf konnte nicht abgebrochen werden.');
    }
  };

  const conversation = conversationQuery.data?.conversation ?? null;
  const messages = conversationQuery.data?.messages ?? [];
  const conversationLoading = activeConversationId !== null && conversationQuery.isPending;
  const conversationErrored = activeConversationId !== null && conversationQuery.isError;

  const streamingMessage: AiConversationMessage | null =
    streamText.length > 0 || activeRunId !== null
      ? {
          id: `streaming-${activeRunId ?? 'done'}`,
          conversationId: activeConversationId ?? '',
          role: 'assistant',
          content: streamText,
          toolName: null,
          toolCallId: null,
          isSummary: false,
          superseded: false,
          runId: activeRunId,
          createdAt: new Date().toISOString(),
        }
      : null;

  const showIntro =
    !conversationLoading &&
    !conversationErrored &&
    messages.length === 0 &&
    commandNotices.length === 0 &&
    streamingMessage === null;

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, streamText, commandNotices.length, toolActivity.length]);

  const models = modelsQuery.data?.models ?? [];
  const defaultModelSlug = modelsQuery.data?.defaultModelSlug ?? null;
  const effectiveModelSlug = conversation?.modelSlug ?? pendingModelSlug ?? defaultModelSlug;
  const effectiveReasoningLevel: AiReasoningLevel =
    conversation?.reasoningLevel ?? pendingReasoningLevel ?? 'none';
  const effectiveVisionCompanionSlug = conversation?.visionCompanionSlug ?? null;
  const selectedModel = models.find((model) => model.slug === effectiveModelSlug) ?? null;

  const openDocumentQuery = useDocument(documentId ?? undefined);
  const openDocument = openDocumentQuery.data ?? null;
  const pageContextEnabled = conversation?.pageContextEnabled ?? pendingPageContextEnabled ?? true;

  // A passage handed over from the editor belongs to the page it was taken
  // from. After navigating away it would be an unlabelled quote from somewhere
  // else, so it is treated as gone rather than silently carried along.
  // Only trusted while it names the page the route is on: a database view id
  // left over from the previous page would describe the wrong table.
  const { state: documentSession } = useDocumentSession();
  const databaseViewId =
    documentSession.activeDatabaseView?.documentId === documentId
      ? documentSession.activeDatabaseView.viewId
      : null;

  const { selection: handedOverSelection, clear: clearSelection } = useAiSelection();
  const selection =
    handedOverSelection !== null && handedOverSelection.documentId === documentId
      ? handedOverSelection
      : null;

  const startNewConversation = React.useCallback(async (): Promise<string> => {
    if (workspaceId === null) throw new Error('A workspace is required to start a conversation');
    const response = await createConversation.mutateAsync({
      workspaceId,
      documentId,
      modelSlug: pendingModelSlug ?? undefined,
      reasoningLevel: pendingReasoningLevel ?? undefined,
      pageContextEnabled: pendingPageContextEnabled ?? undefined,
    });
    setActiveConversationId(response.conversation.id);
    setPendingModelSlug(null);
    setPendingReasoningLevel(null);
    setPendingPageContextEnabled(null);
    return response.conversation.id;
  }, [
    workspaceId,
    documentId,
    pendingModelSlug,
    pendingReasoningLevel,
    pendingPageContextEnabled,
    createConversation,
    setActiveConversationId,
  ]);

  const handleModelChange = (slug: string): void => {
    if (activeConversationId !== null) {
      void updateConversation.mutateAsync({
        conversationId: activeConversationId,
        request: { modelSlug: slug },
      });
    } else {
      setPendingModelSlug(slug);
    }
  };

  const handleReasoningLevelChange = (level: AiReasoningLevel): void => {
    if (activeConversationId !== null) {
      void updateConversation.mutateAsync({
        conversationId: activeConversationId,
        request: { reasoningLevel: level },
      });
    } else {
      setPendingReasoningLevel(level);
    }
  };

  const handlePageContextChange = (enabled: boolean): void => {
    if (activeConversationId === null) {
      setPendingPageContextEnabled(enabled);
      return;
    }
    void updateConversation.mutateAsync({
      conversationId: activeConversationId,
      request: { pageContextEnabled: enabled },
    });
  };

  const handleVisionCompanionChange = (value: string | null): void => {
    // The create request has no field for it; the control is disabled until a
    // conversation exists (ModelPicker enforces this via `visionCompanionEditable`).
    if (activeConversationId === null) return;
    void updateConversation.mutateAsync({
      conversationId: activeConversationId,
      request: { visionCompanionSlug: value },
    });
  };

  const handleSubmit = async (content: string): Promise<void> => {
    if (workspaceId === null || activeRunId !== null) return;
    setError(null);
    setNotice(null);
    try {
      const conversationId = activeConversationId ?? (await startNewConversation());
      const response = await postMessage.mutateAsync({
        conversationId,
        request: {
          content,
          documentId,
          databaseViewId,
          selection:
            selection === null ? null : { blockIds: selection.blockIds, text: selection.text },
        },
      });
      // One hand-over, one message. Leaving it in the chip row would silently
      // attach the same passage to every following question.
      clearSelection();

      if (response.command !== null) {
        const command = response.command;
        setCommandNotices((current) => [
          ...current,
          {
            id: `command-${Date.now().toString(36)}`,
            conversationId,
            role: 'system',
            content: command.message,
            toolName: null,
            toolCallId: null,
            isSummary: false,
            superseded: false,
            runId: null,
            createdAt: new Date().toISOString(),
          },
        ]);
        if (command.conversationChanged && command.conversationId !== null) {
          setActiveConversationId(command.conversationId);
        }
      }

      if (response.run !== null) {
        setStreamText('');
        setToolActivity([]);
        setSequenceState(INITIAL_AI_RUN_SEQUENCE_STATE);
        setRunPhase(null);
        const startedAt = Date.now();
        setRunStartedAt(startedAt);
        setLastActivityAt(startedAt);
        setActiveRunId(response.run.id);
      }
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Die Anfrage konnte nicht gestartet werden.',
      );
    }
  };

  if (workspaceId === null) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
        data-testid="ai-panel"
      >
        Wähle einen Arbeitsbereich.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ai-panel">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <ConversationSwitcher
          workspaceId={workspaceId}
          activeConversationId={activeConversationId}
          onSelect={setActiveConversationId}
          onCreateNew={() => void startNewConversation()}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Neuer Chat"
                onClick={() => void startNewConversation()}
              >
                <PlusIcon />
              </Button>
            }
          />
          <TooltipContent>Neuer Chat</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
        {modelsQuery.isPending ? (
          <Skeleton className="h-8 w-40" />
        ) : (
          <ModelPicker
            models={models}
            defaultModelSlug={defaultModelSlug}
            modelSlug={effectiveModelSlug}
            reasoningLevel={effectiveReasoningLevel}
            visionCompanionSlug={effectiveVisionCompanionSlug}
            visionCompanionEditable={activeConversationId !== null}
            onModelChange={handleModelChange}
            onReasoningLevelChange={handleReasoningLevelChange}
            onVisionCompanionChange={handleVisionCompanionChange}
          />
        )}
        {conversation !== null ? (
          <ContextMeter
            estimatedTokens={conversation.estimatedTokens}
            contextUsagePercent={conversation.contextUsagePercent}
            contextWindowTokens={selectedModel?.contextWindowTokens ?? null}
          />
        ) : null}
      </div>

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      >
        {conversationErrored ? (
          <ErrorState
            title="Unterhaltung nicht verfügbar"
            description="Die Unterhaltung konnte nicht geladen werden."
            onRetry={() => void conversationQuery.refetch()}
          />
        ) : conversationLoading ? (
          <LoadingState variant="skeleton" rows={4} />
        ) : (
          <>
            {showIntro ? (
              <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
                <SparklesIcon className="size-5 text-muted-foreground" aria-hidden />
                <p className="text-sm font-medium">KI-Assistenz</p>
                <p className="text-xs text-muted-foreground">
                  Stelle eine Frage oder nutze /help für Befehle.
                </p>
              </div>
            ) : null}

            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}
            {commandNotices.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}

            {toolActivity.length > 0 ? (
              <div className="space-y-0.5 text-xs text-muted-foreground">
                {toolActivity.map((entry) => (
                  <p key={entry.key}>{toolActivityLine(entry)}</p>
                ))}
              </div>
            ) : null}

            {streamingMessage !== null ? (
              <ChatMessage message={streamingMessage} streaming={activeRunId !== null} />
            ) : null}
          </>
        )}

        {notice !== null ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
        {error !== null ? (
          <p className="rounded-md border border-destructive-text/40 px-3 py-2 text-xs text-destructive-text">
            {error}
          </p>
        ) : null}
      </div>

      {activeRunId !== null ? (
        <RunActivity
          phaseLabel={currentPhaseLabel(toolActivity, streamText, runPhase)}
          elapsedMs={elapsedMs}
          quiet={runQuiet}
          gapDetected={sequenceState.gap}
          onCancel={() => void handleCancelRun()}
          cancelling={cancelRun.isPending}
        />
      ) : null}

      <div className="border-t border-border">
        <ContextChips
          documentTitle={openDocument?.title ?? null}
          isCollection={openDocument?.type === 'COLLECTION'}
          enabled={pageContextEnabled}
          onEnabledChange={handlePageContextChange}
          selectionBlockCount={selection === null ? null : Math.max(1, selection.blockIds.length)}
          onSelectionRemove={clearSelection}
          disabled={activeRunId !== null}
        />
        <ChatComposer disabled={activeRunId !== null} onSubmit={handleSubmit} />
      </div>
    </div>
  );
}
