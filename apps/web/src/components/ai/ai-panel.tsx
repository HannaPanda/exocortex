'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiConversationMessage } from '@exocortex/contracts';

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
import { useChatScrollPreference } from '@/lib/api/preferences-queries';
import { useWorkspaces } from '@/lib/api/workspace-queries';
import { usePersistentState } from '@/lib/use-persistent-state';

import { AiPanelFooter, AiPanelHeader, AiPanelModelBar } from './ai-panel-chrome';
import { useAiSelection, useLiveSelection } from './ai-selection';
import { AiTranscriptArea } from './ai-transcript-area';
import { useStartedChat } from './chat-start';
import {
  parseWorkspaceId,
  resolveChatWorkspace,
  SHARED_CHAT_WORKSPACE_KEY,
} from './chat-workspace';
import { resolveModelChoice, useModelPreference } from './model-choice';
import {
  buildCommandNotice,
  buildStreamingMessages,
  commandAnswersWithList,
  composerBusy,
  describeTranscript,
  liveSelectionOffer,
  resolvePageHandover,
  resolveTranscriptTrace,
} from './panel-view';
import { RunActivity } from './run-activity';
import { currentToolPage, phaseWithoutPage, useRunLabels } from './run-labels';
import { type RunTraceStep } from './run-trace';
import { SharedChatNote } from './shared-chat-note';
import { SourcePicker } from './source-picker';
import { useActiveConversation } from './use-active-conversation';
import { useAiRunTracker, useLastRunFailure } from './use-ai-run-tracker';
import { useChatAttachments, useChatFileUpload, useFileDrop } from './use-chat-attachments';
import { useConversationSettings } from './use-conversation-settings';
import { useLastRunUndo, useSharedChatRoom } from './use-last-run-undo';
import { usePinnedSources } from './use-pinned-sources';
import { useTranscriptFollow } from './use-transcript-follow';

/**
 * Changes whenever something in the transcript did, which is when a
 * transcript that follows has to move (issue #242).
 */
function transcriptContentKey(input: {
  messages: readonly AiConversationMessage[];
  streamingMessages: readonly AiConversationMessage[];
  trace: readonly RunTraceStep[];
  notices: readonly (string | null)[];
}): string {
  const lastStep = input.trace[input.trace.length - 1];
  return [
    input.messages.length,
    input.messages[input.messages.length - 1]?.id ?? '',
    ...input.streamingMessages.map((message) => `${message.id}:${String(message.content.length)}`),
    input.trace.length,
    lastStep?.kind === 'reasoning' ? lastStep.text.length : 0,
    ...input.notices.map((notice) => notice ?? ''),
  ].join('|');
}

/** How the panel is laid out by the shell around it (issue #288). */
export interface AiPanelLayout {
  /** The chat has the screen: the page beside it is folded away. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** The phone's sheet draws its close button over the panel's top right corner. */
  headerInset: boolean;
}

/**
 * A line as wide as a desktop screen is unreadable, so a chat that has the
 * screen keeps the measure it had in the panel, centred (issue #288).
 */
function panelFrameClass(expanded: boolean): string {
  return expanded
    ? 'mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col'
    : 'flex min-h-0 flex-1 flex-col';
}

export interface AiPanelProps {
  workspaceId: string | null;
  documentId: string | null;
  layout: AiPanelLayout;
}

/** A shared page's chat, told which of the reader's workspaces it runs in (issue #234). */
interface SharedChat {
  workspaceName: string;
  choices: readonly { id: string; name: string }[];
  onChoose: (workspaceId: string) => void;
}

/**
 * AI side panel, and the decision which workspace it runs in.
 *
 * The route names the workspace everywhere except on a page somebody shared
 * with the reader (issue #234). There the chat runs in one of the reader's
 * own workspaces, which pays for it and keeps the conversation, and the
 * shared page is the open page of that conversation. What the assistant may
 * do on it is decided by the API, as the reader, on every call.
 */
export function AiPanel({ workspaceId: routeWorkspaceId, documentId, layout }: AiPanelProps) {
  const t = useTranslations('ai.panel');
  const workspaces = useWorkspaces();
  const openPage = useDocument(documentId ?? undefined);
  const [remembered, remember] = usePersistentState<string | null>(
    SHARED_CHAT_WORKSPACE_KEY,
    null,
    parseWorkspaceId,
  );

  const chat = resolveChatWorkspace({
    routeWorkspaceId,
    documentId,
    documentWorkspaceId: openPage.isError ? null : openPage.data?.workspaceId,
    workspaces: workspaces.data,
    remembered,
  });

  if (chat.kind === 'member' || chat.kind === 'shared') {
    return (
      <AiPanelBody
        // A different workspace is a different panel: its own active
        // conversation, its own model preference, its own list.
        key={chat.workspaceId}
        workspaceId={chat.workspaceId}
        documentId={documentId}
        layout={layout}
        shared={
          chat.kind === 'shared'
            ? { workspaceName: chat.workspaceName, choices: chat.choices, onChoose: remember }
            : null
        }
      />
    );
  }

  let message: string | null = null;
  if (chat.kind === 'no_own_workspace') message = t('sharedNeedsWorkspace');
  else if (chat.kind === 'none') message = t('chooseWorkspace');
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
      data-testid="ai-panel"
    >
      {message}
    </div>
  );
}

/**
 * The panel itself, for one workspace.
 *
 * Server state (models, conversations, messages) lives entirely in TanStack
 * Query; the only local state is the in-flight streaming assistant buffer,
 * transient tool-activity lines and ephemeral slash-command notices. This is
 * the deliberate difference from the previous version, which mirrored the
 * transcript into a local array and lost it on every reload.
 */
function AiPanelBody({
  workspaceId,
  documentId,
  layout,
  shared,
}: {
  workspaceId: string;
  documentId: string | null;
  layout: AiPanelLayout;
  shared: SharedChat | null;
}) {
  // Per tab and per page, never shared between tabs (issue #231).
  const [activeConversationId, setActiveConversationId] = useActiveConversation(
    workspaceId,
    documentId,
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
  // A run is answering, or a summary somebody asked for with `/compact` is
  // being written (issue #287): either way the composer waits.
  const busy = composerBusy(activeRunId, conversation);
  const settings = useConversationSettings({
    conversationId: activeConversationId,
    conversation,
    preference,
  });
  const { pendingPageContextEnabled, clearPendingPageContext } = settings;
  const messages = conversationQuery.data?.messages ?? [];
  const lastRunFailure = useLastRunFailure(
    conversationQuery.data?.lastRun ?? null,
    activeRunId !== null || error !== null,
  );
  const streamingMessages = buildStreamingMessages({
    stream: run.stream,
    messages,
    activeRunId,
    conversationId: activeConversationId,
  });
  const transcript = describeTranscript({
    open: activeConversationId !== null,
    query: { pending: conversationQuery.isPending, errored: conversationQuery.isError },
    messageCount: messages.length,
    commandNotice,
    streamingCount: streamingMessages.length,
  });
  const trace = resolveTranscriptTrace({
    activeRunId,
    steps: run.trace,
    finished: run.finishedTrace,
  });

  const shownError = error ?? lastRunFailure;
  // The reader's own choice, on every device (issue #282); following until it is known.
  const chatScroll = useChatScrollPreference();
  const follow = useTranscriptFollow(
    scrollRef,
    transcriptContentKey({
      messages,
      streamingMessages,
      trace: run.trace,
      notices: [commandNotice?.id ?? null, notice, shownError],
    }),
    activeConversationId,
    chatScroll.mode,
  );

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
  const selectionOffer = useSelectionOffer(documentId, selection);

  const startNewConversation = React.useCallback(async (): Promise<string> => {
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
  usePaletteRequest('new-chat', () => void startNewConversation(), true);
  // "Letzten KI-Lauf rückgängig machen", the same preview as under the answer.
  const lastRunUndo = useLastRunUndo({
    conversationId: activeConversationId,
    detail: conversationQuery.data,
    activeRunId,
    onNothing: setNotice,
  });
  useSharedChatRoom(workspaceId, shared);

  const pinnedSources = usePinnedSources({
    conversationId: activeConversationId,
    ensureConversation: startNewConversation,
    onError: setError,
  });
  const attachments = useChatAttachments({
    conversationId: activeConversationId,
    ensureConversation: startNewConversation,
    onError: setError,
  });
  const fileDrop = useFileDrop(attachments.add);
  const uploadStartFiles = useChatFileUpload(setError);

  /**
   * Sends `content`, into the open conversation or, with `fresh`, into a new
   * one. A fresh start does not wait for the open conversation's run: that run
   * goes on in its own chat, and this one has nothing in flight yet.
   */
  const handleSubmit = async (
    content: string,
    fresh = false,
    startFiles: readonly File[] = [],
  ): Promise<void> => {
    if (busy && !fresh) return;
    setError(null);
    setNotice(null);
    setCommandNotice(null);
    try {
      const open = fresh ? null : activeConversationId;
      const conversationId = open ?? (await startNewConversation());
      // The pictures above the composer belong to the open conversation; a
      // question begun elsewhere (issue #288) does not take them along.
      const attachmentIds = [
        ...attachments.idsFor(open),
        ...(await uploadStartFiles(conversationId, startFiles)),
      ];
      const response = await postMessage.mutateAsync({
        conversationId,
        request: {
          content,
          attachmentIds,
          documentId,
          databaseViewId,
          selection:
            selection === null ? null : { blockIds: selection.blockIds, text: selection.text },
        },
      });
      // One hand-over, one message. Leaving it in the chip row would silently
      // attach the same passage to every following question.
      clearSelection({ sent: true });
      // A command answers without a message, so its pictures wait for the next one.
      if (response.command === null) attachments.sent();

      if (response.command !== null) {
        const command = response.command;
        // A command that answers with a list (`/help`, `/tools`, `/rules`) is
        // something to read, so it keeps a bubble. Everything else confirms a
        // changed setting in one line and belongs in the notice slot, where the
        // next message replaces it instead of stacking below the transcript.
        if (commandAnswersWithList(command.command)) {
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

      if (response.run !== null) {
        run.beginRun(response.run.id);
        // Whoever asks wants to see the answer arrive, wherever they were
        // reading: at the end, or from its start (issue #282).
        follow.sent(response.userMessage?.id ?? null);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t('requestFailed'));
    }
  };

  // A question typed on the workspace's start page (issue #288) begins a new
  // chat here, because this is where its answer is streamed.
  useStartedChat(workspaceId, (text, files) => void handleSubmit(text, true, files));

  return (
    <div
      className={panelFrameClass(layout.expanded)}
      data-testid="ai-panel"
      data-expanded={String(layout.expanded)}
      {...fileDrop.handlers}
    >
      <AiPanelHeader
        expanded={layout.expanded}
        onExpandedChange={layout.onExpandedChange}
        inset={layout.headerInset}
        workspaceId={workspaceId}
        activeConversationId={activeConversationId}
        onSelect={setActiveConversationId}
        onCreateNew={() => void startNewConversation()}
        chatScroll={chatScroll.mode}
        onChatScrollChange={(mode) =>
          chatScroll.change(mode, { onError: () => setError(t('chatScrollFailed')) })
        }
      />

      {shared === null ? null : (
        <SharedChatNote
          workspaceId={workspaceId}
          workspaceName={shared.workspaceName}
          choices={shared.choices}
          onChoose={shared.onChoose}
        />
      )}

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
        trace={trace}
        streamingMessages={streamingMessages}
        streaming={activeRunId !== null}
        notice={notice}
        error={shownError}
        conversationId={activeConversationId}
        follow={follow}
        runWrites={conversationQuery.data?.runWrites}
        activeRunId={activeRunId}
      />

      {activeRunId !== null ? (
        <RunActivity
          phaseLabel={runLabel(phaseWithoutPage(toolActivity, streamText, run.runPhase))}
          page={currentToolPage(toolActivity)}
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
        onSelectionRemove={() => clearSelection()}
        liveSelection={selectionOffer.offer}
        onSelectionAdd={selectionOffer.take}
        pinned={pinnedSources.pinned}
        onPinRequest={() => setSourcePickerOpen(true)}
        onPinModeChange={pinnedSources.setMode}
        onPinRemove={pinnedSources.remove}
        busy={busy}
        onSubmit={handleSubmit}
        attachments={attachments}
        dragging={fileDrop.dragging}
      />
      <SourcePicker
        workspaceId={workspaceId}
        // A pinned source belongs to the conversation's workspace, and a
        // shared page does not: it is the open page, never a pin.
        openDocumentId={shared === null ? documentId : null}
        openDocumentIsCollection={shared === null && openDocument?.type === 'COLLECTION'}
        open={sourcePickerOpen}
        onOpenChange={setSourcePickerOpen}
        onPick={pinnedSources.add}
      />
      {lastRunUndo}
    </div>
  );
}

/**
 * What is marked in the text right now, offered rather than sent (#249), and
 * the click that takes the offer and makes it the pending selection.
 */
function useSelectionOffer(
  documentId: string | null,
  pending: { blockIds: string[]; text: string } | null,
): { offer: { text: string } | null; take: () => void } {
  const { handOver } = useAiSelection();
  const live = useLiveSelection()?.live ?? null;
  const offer = liveSelectionOffer({ documentId, live, pending });
  const take = React.useCallback(() => {
    if (offer !== null) handOver(offer);
  }, [offer, handOver]);
  return { offer, take };
}
