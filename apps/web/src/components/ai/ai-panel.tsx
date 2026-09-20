'use client';

import { PlusIcon, SparklesIcon } from 'lucide-react';
import * as React from 'react';

import {
  type AiConversation,
  type AiConversationMessage,
  type AiConversationSource,
  type AiConversationSourceMode,
  type AiConversationSourcesResponse,
  type AiReasoningLevel,
  type AiRunPhase,
  type DocumentDetail,
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
  useAiConversation,
  useAiModels,
  useCreateAiConversation,
  usePostConversationMessage,
  useUpdateAiConversation,
} from '@/lib/api/ai-queries';
import { ApiError } from '@/lib/api/client';
import { useDocument } from '@/lib/api/document-queries';
import { usePersistentState } from '@/lib/use-persistent-state';

import { useAiSelection } from './ai-selection';
import { ChatComposer } from './chat-composer';
import { ChatMessage } from './chat-message';
import { ContextChips } from './context-chips';
import { ContextMeter } from './context-meter';
import { ConversationSwitcher } from './conversation-switcher';
import { type ModelChoice, resolveModelChoice, useModelPreference } from './model-choice';
import { ModelPicker } from './model-picker';
import { activeConversationKey, parseConversationId } from './panel-state';
import { RunActivity } from './run-activity';
import { SourcePicker } from './source-picker';
import { Transcript } from './transcript';
import { type ToolActivityEntry, useAiRunTracker } from './use-ai-run-tracker';
import { usePinnedSources } from './use-pinned-sources';

export interface AiPanelProps {
  workspaceId: string | null;
  documentId: string | null;
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

/** What one line of tool activity ends with, per status. */
const TOOL_STATUS_SUFFIX: Record<ToolActivityEntry['status'], string> = {
  started: 'wird ausgeführt …',
  succeeded: '… fertig',
  failed: '… fehlgeschlagen',
  // Not a failure: the run had read content from outside and is therefore not
  // allowed to change anything any more (issue #56).
  refused: '… abgelehnt, weil dieser Lauf Fremdinhalte gelesen hat',
};

function toolActivityLine(entry: ToolActivityEntry): string {
  const suffix = TOOL_STATUS_SUFFIX[entry.status];
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
    activeConversationKey(workspaceId),
    null,
    parseConversationId,
  );

  const modelsQuery = useAiModels();
  const conversationQuery = useAiConversation(activeConversationId);
  const createConversation = useCreateAiConversation();
  const updateConversation = useUpdateAiConversation();
  const postMessage = usePostConversationMessage();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Model and thinking level are remembered per workspace: the panel is often
  // empty when they are chosen, and an empty panel has no conversation row to
  // write them to. They also seed every following conversation.
  const preference = useModelPreference(workspaceId);
  // Same problem as the model choice, without the memory: the chip is operable
  // before the first message, when there is no conversation row to write it to.
  // It travels along in the create request and is deliberately not remembered,
  // because page context is a decision about one conversation.
  const [pendingPageContextEnabled, setPendingPageContextEnabled] = React.useState<boolean | null>(
    null,
  );

  const [sourcePickerOpen, setSourcePickerOpen] = React.useState(false);

  const run = useAiRunTracker(activeConversationId);
  const {
    activeRunId,
    streamText,
    toolActivity,
    notice,
    error,
    setError,
    setNotice,
    commandNotice,
    setCommandNotice,
  } = run;

  const conversation = conversationQuery.data?.conversation ?? null;
  const messages = conversationQuery.data?.messages ?? [];
  const streamingMessage = buildStreamingMessage({
    streamText,
    activeRunId,
    conversationId: activeConversationId,
  });
  const transcript = describeTranscript({
    open: activeConversationId !== null,
    query: { pending: conversationQuery.isPending, errored: conversationQuery.isError },
    messageCount: messages.length,
    commandNotice,
    streamingMessage,
  });

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, streamText, commandNotice?.id, toolActivity.length, notice]);

  const modelChoice = resolveModelChoice({
    registry: modelsQuery.data ?? null,
    conversation,
    preference,
  });

  const openDocumentQuery = useDocument(documentId ?? undefined);
  const openDocument = openDocumentQuery.data ?? null;
  const pageContextEnabled = conversation?.pageContextEnabled ?? pendingPageContextEnabled ?? true;

  // A passage handed over from the editor belongs to the page it was taken
  // from. After navigating away it would be an unlabelled quote from somewhere
  // else, so it is treated as gone rather than silently carried along.
  // Only trusted while it names the page the route is on: a database view id
  // left over from the previous page would describe the wrong table.
  const { state: documentSession } = useDocumentSession();
  const { selection: handedOverSelection, clear: clearSelection } = useAiSelection();
  const { databaseViewId, selection } = resolvePageHandover({
    documentId,
    activeDatabaseView: documentSession.activeDatabaseView,
    handedOverSelection,
  });

  const startNewConversation = React.useCallback(async (): Promise<string> => {
    if (workspaceId === null) throw new Error('A workspace is required to start a conversation');
    const response = await createConversation.mutateAsync({
      workspaceId,
      documentId,
      modelSlug: preference.modelSlug ?? undefined,
      reasoningLevel: preference.reasoningLevel ?? undefined,
      pageContextEnabled: pendingPageContextEnabled ?? undefined,
    });
    setActiveConversationId(response.conversation.id);
    setPendingPageContextEnabled(null);
    return response.conversation.id;
  }, [
    workspaceId,
    documentId,
    preference.modelSlug,
    preference.reasoningLevel,
    pendingPageContextEnabled,
    createConversation,
    setActiveConversationId,
  ]);

  const pinnedSources = usePinnedSources({
    conversationId: activeConversationId,
    ensureConversation: startNewConversation,
    onError: setError,
  });

  const handleModelChange = (slug: string): void => {
    preference.remember({ modelSlug: slug });
    if (activeConversationId !== null) {
      void updateConversation.mutateAsync({
        conversationId: activeConversationId,
        request: { modelSlug: slug },
      });
    }
  };

  const handleReasoningLevelChange = (level: AiReasoningLevel): void => {
    preference.remember({ reasoningLevel: level });
    if (activeConversationId !== null) {
      void updateConversation.mutateAsync({
        conversationId: activeConversationId,
        request: { reasoningLevel: level },
      });
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
    setCommandNotice(null);
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
        // A command that answers with a list (`/help`, `/tools`, `/rules`) is
        // something to read, so it keeps a bubble. Everything else confirms a
        // changed setting in one line and belongs in the notice slot, where the
        // next message replaces it instead of stacking below the transcript.
        if (command.message.includes('\n')) {
          setCommandNotice({
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
          });
        } else if (command.command !== 'clear' || messages.length === 0) {
          // `/clear` says it in the transcript itself, by way of the boundary
          // that appears once the refetched messages come back superseded --
          // except when there was nothing to cut, and nothing would show.
          setNotice(command.message);
        }
        if (command.conversationChanged && command.conversationId !== null) {
          setActiveConversationId(command.conversationId);
        }
      }

      if (response.run !== null) run.beginRun(response.run.id);
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
      <AiPanelHeader
        workspaceId={workspaceId}
        activeConversationId={activeConversationId}
        onSelect={setActiveConversationId}
        onCreateNew={() => void startNewConversation()}
      />

      <AiPanelModelBar
        pending={modelsQuery.isPending}
        choice={modelChoice}
        visionCompanionEditable={activeConversationId !== null}
        conversation={conversation}
        onModelChange={handleModelChange}
        onReasoningLevelChange={handleReasoningLevelChange}
        onVisionCompanionChange={handleVisionCompanionChange}
      />

      <AiTranscriptArea
        scrollRef={scrollRef}
        errored={transcript.errored}
        loading={transcript.loading}
        onRetry={() => void conversationQuery.refetch()}
        showIntro={transcript.showIntro}
        messages={messages}
        commandNotice={commandNotice}
        toolActivity={toolActivity}
        streamingMessage={streamingMessage}
        streaming={activeRunId !== null}
        notice={notice}
        error={error}
      />

      {activeRunId !== null ? (
        <RunActivity
          phaseLabel={currentPhaseLabel(toolActivity, streamText, run.runPhase)}
          elapsedMs={run.elapsedMs}
          quiet={run.runQuiet}
          gapDetected={run.gapDetected}
          onCancel={() => void run.cancel()}
          cancelling={run.cancelling}
        />
      ) : null}

      <AiPanelFooter
        openDocument={openDocument}
        pageContextEnabled={pageContextEnabled}
        onEnabledChange={handlePageContextChange}
        selection={selection}
        onSelectionRemove={clearSelection}
        pinned={pinnedSources.pinned}
        onPinRequest={() => setSourcePickerOpen(true)}
        onPinModeChange={pinnedSources.setMode}
        onPinRemove={pinnedSources.remove}
        busy={activeRunId !== null}
        onSubmit={handleSubmit}
      />
      {workspaceId === null ? null : (
        <SourcePicker
          workspaceId={workspaceId}
          openDocumentId={documentId}
          openDocumentIsCollection={openDocument?.type === 'COLLECTION'}
          open={sourcePickerOpen}
          onOpenChange={setSourcePickerOpen}
          onPick={pinnedSources.add}
        />
      )}
    </div>
  );
}

/**
 * The scrolling half of the panel: the transcript, whatever the model is doing
 * right now, and the two one-line notices below it.
 */
function AiTranscriptArea({
  scrollRef,
  errored,
  loading,
  onRetry,
  showIntro,
  messages,
  commandNotice,
  toolActivity,
  streamingMessage,
  streaming,
  notice,
  error,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  errored: boolean;
  loading: boolean;
  onRetry: () => void;
  showIntro: boolean;
  messages: AiConversationMessage[];
  commandNotice: AiConversationMessage | null;
  toolActivity: ToolActivityEntry[];
  streamingMessage: AiConversationMessage | null;
  streaming: boolean;
  notice: string | null;
  error: string | null;
}) {
  return (
    <div
      ref={scrollRef}
      role="log"
      aria-live="polite"
      className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
    >
      {errored ? (
        <ErrorState
          title="Unterhaltung nicht verfügbar"
          description="Die Unterhaltung konnte nicht geladen werden."
          onRetry={onRetry}
        />
      ) : loading ? (
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

          <Transcript messages={messages} />
          {commandNotice !== null ? <ChatMessage message={commandNotice} /> : null}

          {toolActivity.length > 0 ? (
            <div className="space-y-0.5 text-xs text-muted-foreground">
              {toolActivity.map((entry) => (
                <p key={entry.key}>{toolActivityLine(entry)}</p>
              ))}
            </div>
          ) : null}

          {streamingMessage !== null ? (
            <ChatMessage message={streamingMessage} streaming={streaming} />
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
  );
}

/**
 * The assistant bubble for an answer that is still arriving, or `null` when
 * there is nothing in flight and nothing left over from one.
 */
function buildStreamingMessage(input: {
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

/** Which model answers, how hard it thinks, and how full the context already is. */
function AiPanelModelBar({
  pending,
  choice,
  visionCompanionEditable,
  conversation,
  onModelChange,
  onReasoningLevelChange,
  onVisionCompanionChange,
}: {
  pending: boolean;
  choice: ModelChoice;
  visionCompanionEditable: boolean;
  conversation: AiConversation | null;
  onModelChange: (slug: string) => void;
  onReasoningLevelChange: (level: AiReasoningLevel) => void;
  onVisionCompanionChange: (value: string | null) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
      {pending ? (
        <Skeleton className="h-8 w-40" />
      ) : (
        <ModelPicker
          models={choice.models}
          defaultModelSlug={choice.defaultModelSlug}
          modelSlug={choice.modelSlug}
          reasoningLevel={choice.reasoningLevel}
          visionCompanionSlug={choice.visionCompanionSlug}
          visionCompanionEditable={visionCompanionEditable}
          onModelChange={onModelChange}
          onReasoningLevelChange={onReasoningLevelChange}
          onVisionCompanionChange={onVisionCompanionChange}
        />
      )}
      {conversation !== null ? (
        <ContextMeter
          estimatedTokens={conversation.estimatedTokens}
          contextUsagePercent={conversation.contextUsagePercent}
          contextWindowTokens={choice.selectedModel?.contextWindowTokens ?? null}
        />
      ) : null}
    </div>
  );
}

/** The chips that say what the KI will be told, and the box to type into. */
function AiPanelFooter({
  openDocument,
  pageContextEnabled,
  onEnabledChange,
  selection,
  onSelectionRemove,
  pinned,
  onPinRequest,
  onPinModeChange,
  onPinRemove,
  busy,
  onSubmit,
}: {
  openDocument: DocumentDetail | null;
  pageContextEnabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  selection: { blockIds: string[]; text: string } | null;
  onSelectionRemove: () => void;
  pinned: AiConversationSourcesResponse | null;
  onPinRequest: () => void;
  onPinModeChange: (source: AiConversationSource, mode: AiConversationSourceMode) => void;
  onPinRemove: (source: AiConversationSource) => void;
  busy: boolean;
  onSubmit: (content: string) => Promise<void>;
}) {
  return (
    <div className="border-t border-border">
      <ContextChips
        documentTitle={openDocument?.title ?? null}
        isCollection={openDocument?.type === 'COLLECTION'}
        enabled={pageContextEnabled}
        onEnabledChange={onEnabledChange}
        selectionBlockCount={selection === null ? null : Math.max(1, selection.blockIds.length)}
        onSelectionRemove={onSelectionRemove}
        pinned={pinned}
        onPinRequest={onPinRequest}
        onPinModeChange={onPinModeChange}
        onPinRemove={onPinRemove}
        disabled={busy}
      />
      <ChatComposer disabled={busy} onSubmit={onSubmit} />
    </div>
  );
}

/**
 * What of the open page travels with the next message.
 *
 * Both parts are only trusted while they name the page the route is on: a
 * passage handed over from the editor would otherwise become an unlabelled
 * quote from somewhere else after navigating away, and a database view id left
 * over from the previous page would describe the wrong table.
 */
function resolvePageHandover(input: {
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

/** Which conversation is open, and the one button that starts another. */
function AiPanelHeader({
  workspaceId,
  activeConversationId,
  onSelect,
  onCreateNew,
}: {
  workspaceId: string;
  activeConversationId: string | null;
  onSelect: (conversationId: string | null) => void;
  onCreateNew: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
      <ConversationSwitcher
        workspaceId={workspaceId}
        activeConversationId={activeConversationId}
        onSelect={onSelect}
        onCreateNew={onCreateNew}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Neuer Chat" onClick={onCreateNew}>
              <PlusIcon />
            </Button>
          }
        />
        <TooltipContent>Neuer Chat</TooltipContent>
      </Tooltip>
    </div>
  );
}

/**
 * What the transcript area is showing: a failure, a skeleton, the introduction,
 * or the conversation itself.
 *
 * A conversation that has not been opened yet is neither loading nor failed --
 * there is nothing to load -- which is why every state hangs off `open`.
 */
function describeTranscript(input: {
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
