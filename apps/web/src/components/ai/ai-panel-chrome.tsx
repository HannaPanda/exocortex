'use client';

import { Maximize2Icon, Minimize2Icon, MoreHorizontalIcon, PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  type AiConversation,
  type AiConversationSource,
  type AiConversationSourceMode,
  type AiConversationSourcesResponse,
  type AiReasoningLevel,
  type ChatScrollMode,
  type DocumentDetail,
} from '@exocortex/contracts';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { ChatComposer } from './chat-composer';
import { ChatFileChip } from './chat-file-chip';
import { ContextChips } from './context-chips';
import { ContextMeter } from './context-meter';
import { ConversationSwitcher } from './conversation-switcher';
import { type ModelChoice } from './model-choice';
import { ModelPicker } from './model-picker';
import { type ChatAttachments } from './use-chat-attachments';

/**
 * The fixed parts of the AI panel around its transcript: the conversation
 * switcher on top, the model bar under it, the context chips and the composer
 * at the bottom (split out of `ai-panel.tsx`, issue #97).
 */

/**
 * Which conversation is open, the one button that starts another, the one
 * that gives the chat the screen (issue #288), and the panel's menu: whether
 * the transcript follows an answer or stays at its start (issue #282), the
 * reader's own choice on every device.
 */
export function AiPanelHeader({
  expanded,
  onExpandedChange,
  inset,
  workspaceId,
  activeConversationId,
  onSelect,
  onCreateNew,
  chatScroll,
  onChatScrollChange,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Leaves room for the close button a phone's sheet draws in the corner. */
  inset: boolean;
  workspaceId: string;
  activeConversationId: string | null;
  onSelect: (conversationId: string | null) => void;
  onCreateNew: () => void;
  chatScroll: ChatScrollMode;
  onChatScrollChange: (mode: ChatScrollMode) => void;
}) {
  const t = useTranslations('ai.panel');
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 border-b border-border px-2 py-1.5',
        inset && 'pr-10',
      )}
    >
      <ConversationSwitcher
        workspaceId={workspaceId}
        activeConversationId={activeConversationId}
        onSelect={onSelect}
        onCreateNew={onCreateNew}
      />
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('newChat')}
                onClick={onCreateNew}
              >
                <PlusIcon />
              </Button>
            }
          />
          <TooltipContent>{t('newChat')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={expanded ? t('collapse') : t('expand')}
                data-testid="ai-expand"
                onClick={() => onExpandedChange(!expanded)}
              >
                {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
              </Button>
            }
          />
          <TooltipContent>{expanded ? t('collapse') : t('expand')}</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('menu')}
                      data-testid="ai-panel-menu"
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  }
                />
              }
            />
            <TooltipContent>{t('menu')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuCheckboxItem
              checked={chatScroll === 'answerStart'}
              onCheckedChange={(checked) => onChatScrollChange(checked ? 'answerStart' : 'follow')}
              data-testid="ai-stay-at-answer-start"
            >
              <span className="flex flex-col gap-0.5">
                <span>{t('stayAtAnswerStart')}</span>
                <span className="text-xs text-muted-foreground">{t('stayAtAnswerStartHint')}</span>
              </span>
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
          contextTokens={conversation.contextTokens}
          contextTokensMeasured={conversation.contextTokensMeasured}
          contextWindowTokens={
            choice.selectedModel?.contextWindowTokens ?? conversation.contextWindowTokens
          }
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
  liveSelection,
  onSelectionAdd,
  pinned,
  onPinRequest,
  onPinModeChange,
  onPinRemove,
  busy,
  onSubmit,
  attachments,
  dragging,
}: {
  openDocument: DocumentDetail | null;
  pageContextEnabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  selection: { blockIds: string[]; text: string } | null;
  onSelectionRemove: () => void;
  /** What is marked in the text right now and not handed over yet (#249). */
  liveSelection: { text: string } | null;
  onSelectionAdd: () => void;
  pinned: AiConversationSourcesResponse | null;
  onPinRequest: () => void;
  onPinModeChange: (source: AiConversationSource, mode: AiConversationSourceMode) => void;
  onPinRemove: (source: AiConversationSource) => void;
  busy: boolean;
  onSubmit: (content: string) => Promise<void>;
  /** The pictures waiting for the next message (issue #223). */
  attachments: ChatAttachments;
  /** Files are being dragged over the panel: the footer says where they go. */
  dragging: boolean;
}) {
  const t = useTranslations('ai.composer');
  return (
    <div
      className={cn(
        'border-t border-border',
        dragging && 'rounded-md bg-accent/40 outline-2 outline-primary outline-dashed',
      )}
    >
      {dragging ? (
        <p className="px-3 pt-2 text-xs text-muted-foreground" data-testid="ai-drop-hint">
          {t('dropHint')}
        </p>
      ) : null}
      <ContextChips
        documentTitle={openDocument?.title ?? null}
        isCollection={openDocument?.type === 'COLLECTION'}
        enabled={pageContextEnabled}
        onEnabledChange={onEnabledChange}
        selection={selection}
        onSelectionRemove={onSelectionRemove}
        liveSelection={liveSelection}
        onSelectionAdd={onSelectionAdd}
        pinned={pinned}
        onPinRequest={onPinRequest}
        onPinModeChange={onPinModeChange}
        onPinRemove={onPinRemove}
        disabled={busy}
      />
      {attachments.files.length === 0 ? null : (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 pt-2">
          {attachments.files.map((file) => (
            <ChatFileChip
              key={file.localId}
              file={file}
              disabled={busy}
              onRemove={() => attachments.remove(file.localId)}
            />
          ))}
        </div>
      )}
      <ChatComposer
        disabled={busy}
        onSubmit={onSubmit}
        files={{
          onFiles: attachments.add,
          ready: attachments.readyIds.length > 0,
          uploading: attachments.uploading,
        }}
      />
    </div>
  );
}
