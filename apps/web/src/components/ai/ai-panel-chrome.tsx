'use client';

import { PlusIcon } from 'lucide-react';

import {
  type AiConversation,
  type AiConversationSource,
  type AiConversationSourceMode,
  type AiConversationSourcesResponse,
  type AiReasoningLevel,
  type DocumentDetail,
} from '@exocortex/contracts';
import { Button, Skeleton, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

import { ChatComposer } from './chat-composer';
import { ContextChips } from './context-chips';
import { ContextMeter } from './context-meter';
import { ConversationSwitcher } from './conversation-switcher';
import { type ModelChoice } from './model-choice';
import { ModelPicker } from './model-picker';

/**
 * The fixed parts of the AI panel around its transcript: the conversation
 * switcher on top, the model bar under it, the context chips and the composer
 * at the bottom (split out of `ai-panel.tsx`, issue #97).
 */

/** Which conversation is open, and the one button that starts another. */
export function AiPanelHeader({
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

/** Which model answers, how hard it thinks, and how full the context already is. */
export function AiPanelModelBar({
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
export function AiPanelFooter({
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
