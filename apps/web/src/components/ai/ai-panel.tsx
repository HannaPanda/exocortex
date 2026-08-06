'use client';

import { useQueryClient } from '@tanstack/react-query';
import { PlusIcon, SparklesIcon } from 'lucide-react';
import * as React from 'react';

import { type AiConversationMessage, type AiReasoningLevel } from '@exocortex/contracts';
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
  useCreateAiConversation,
  usePostConversationMessage,
  useUpdateAiConversation,
} from '@/lib/api/ai-queries';
import { ApiError } from '@/lib/api/client';
import { useDocument } from '@/lib/api/queries';
import { useRealtimeEvent } from '@/lib/realtime/realtime-provider';
import { usePersistentState } from '@/lib/use-persistent-state';

import { useAiSelection } from './ai-selection';
import { ChatComposer } from './chat-composer';
import { ChatMessage } from './chat-message';
import { ContextChips } from './context-chips';
import { ContextMeter } from './context-meter';
import { ConversationSwitcher } from './conversation-switcher';
import { ModelPicker } from './model-picker';

export interface AiPanelProps {
  workspaceId: string | null;
  documentId: string | null;
}

interface ToolActivityEntry {
  key: string;
  toolName: string;
  status: 'started' | 'succeeded' | 'failed';
}

/**
 * Reasons a run can fail that the user can actually do something about. Codes
 * outside this map keep the generic message.
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

function toolActivityLine(entry: ToolActivityEntry): string {
  const suffix =
    entry.status === 'started'
      ? 'wird ausgeführt …'
      : entry.status === 'succeeded'
        ? '… fertig'
        : '… fehlgeschlagen';
  return `Werkzeug ${entry.toolName} ${suffix}`;
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
  }

  useRealtimeEvent('ai.run.progress', (event) => {
    if (event.payload.runId !== activeRunId) return;
    setStreamText((current) => current + event.payload.delta);
  });

  useRealtimeEvent('ai.run.tool_call', (event) => {
    if (event.payload.runId !== activeRunId) return;
    setToolActivity((current) => [
      ...current,
      {
        key: `${event.payload.iteration}:${event.payload.toolName}:${event.payload.status}`,
        toolName: event.payload.toolName,
        status: event.payload.status,
      },
    ]);
  });

  useRealtimeEvent('ai.run.completed', (event) => {
    if (event.payload.runId !== activeRunId) return;
    setActiveRunId(null);
    setToolActivity([]);
    // Keep the streaming bubble on screen (its content is already final) until
    // the refetched conversation carries the persisted message, so nothing
    // flickers or disappears in between.
    if (activeConversationId !== null) {
      void queryClient
        .invalidateQueries({ queryKey: aiQueryKeys.conversation(activeConversationId) })
        .then(() => setStreamText(''));
    } else {
      setStreamText('');
    }
  });

  useRealtimeEvent('ai.run.failed', (event) => {
    if (event.payload.runId !== activeRunId) return;
    setActiveRunId(null);
    setStreamText('');
    setToolActivity([]);
    setError(
      RUN_ERROR_MESSAGES[event.payload.errorCode] ?? 'Die KI-Antwort konnte nicht erzeugt werden.',
    );
  });

  useRealtimeEvent('ai.conversation.compacted', (event) => {
    if (event.payload.conversationId !== activeConversationId) return;
    setNotice('Älterer Verlauf wurde zusammengefasst.');
    void queryClient.invalidateQueries({
      queryKey: aiQueryKeys.conversation(event.payload.conversationId),
    });
  });

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
