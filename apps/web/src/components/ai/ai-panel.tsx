'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { usePaletteRequest } from '@/components/palette/palette-requests';
import { useDocumentSession } from '@/components/shell/document-session';
import {
  useAiConversation,
  useAiModels,
  useCreateAiConversation,
  usePostConversationMessage,
} from '@/lib/api/ai-queries';
import { ApiError } from '@/lib/api/client';
import { useDocument } from '@/lib/api/document-queries';
import { usePersistentState } from '@/lib/use-persistent-state';

import { AiPanelFooter, AiPanelHeader, AiPanelModelBar } from './ai-panel-chrome';
import { useAiSelection } from './ai-selection';
import { AiTranscriptArea } from './ai-transcript-area';
import { resolveModelChoice, useModelPreference } from './model-choice';
import { activeConversationKey, parseConversationId } from './panel-state';
import {
  buildCommandNotice,
  buildStreamingMessage,
  describeTranscript,
  resolvePageHandover,
} from './panel-view';
import { RunActivity } from './run-activity';
import { currentPhaseLabel, useRunLabels } from './run-labels';
import { SourcePicker } from './source-picker';
import { useAiRunTracker } from './use-ai-run-tracker';
import { useConversationSettings } from './use-conversation-settings';
import { usePinnedSources } from './use-pinned-sources';

export interface AiPanelProps {
  workspaceId: string | null;
  documentId: string | null;
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

  const t = useTranslations('ai.panel');
  const runLabel = useRunLabels();
  const modelsQuery = useAiModels();
  const conversationQuery = useAiConversation(activeConversationId);
  const createConversation = useCreateAiConversation();
  const postMessage = usePostConversationMessage();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Model and thinking level are remembered per workspace: the panel is often
  // empty when they are chosen, and an empty panel has no conversation row to
  // write them to. They also seed every following conversation.
  const preference = useModelPreference(workspaceId);

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
  const settings = useConversationSettings({
    conversationId: activeConversationId,
    conversation,
    preference,
  });
  const { pendingPageContextEnabled, clearPendingPageContext } = settings;
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
    clearPendingPageContext();
    return response.conversation.id;
  }, [
    workspaceId,
    documentId,
    preference.modelSlug,
    preference.reasoningLevel,
    pendingPageContextEnabled,
    clearPendingPageContext,
    createConversation,
    setActiveConversationId,
  ]);

  // "Neuer Chat" from the palette, which also opens the panel this is in.
  usePaletteRequest('new-chat', () => void startNewConversation(), workspaceId !== null);

  const pinnedSources = usePinnedSources({
    conversationId: activeConversationId,
    ensureConversation: startNewConversation,
    onError: setError,
  });

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
          setCommandNotice(buildCommandNotice(conversationId, command.message));
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
      setError(caught instanceof ApiError ? caught.message : t('requestFailed'));
    }
  };

  if (workspaceId === null) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
        data-testid="ai-panel"
      >
        {t('chooseWorkspace')}
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
        onModelChange={settings.changeModel}
        onReasoningLevelChange={settings.changeReasoningLevel}
        onVisionCompanionChange={settings.changeVisionCompanion}
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
        conversationId={activeConversationId}
      />

      {activeRunId !== null ? (
        <RunActivity
          phaseLabel={runLabel(currentPhaseLabel(toolActivity, streamText, run.runPhase))}
          elapsedMs={run.elapsedMs}
          quiet={run.runQuiet}
          gapDetected={run.gapDetected}
          onCancel={() => void run.cancel()}
          cancelling={run.cancelling}
        />
      ) : null}

      <AiPanelFooter
        openDocument={openDocument}
        pageContextEnabled={settings.pageContextEnabled}
        onEnabledChange={settings.changePageContext}
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
