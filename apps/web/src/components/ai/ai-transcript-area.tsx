'use client';

import { ArrowDownIcon, ArrowUpIcon, SparklesIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type * as React from 'react';

import { type AiConversationMessage, type AiRunWrittenPages } from '@exocortex/contracts';
import {
  Button,
  ErrorState,
  LoadingState,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@exocortex/ui';

import { ConversationCheckpoints } from '@/components/attention/conversation-checkpoints';

import { ChatMessage } from './chat-message';
import { Transcript, type TranscriptTrace } from './transcript';
import { type TranscriptFollow } from './use-transcript-follow';

/**
 * The scrolling half of the panel: the transcript, whatever the model is doing
 * right now, and the two one-line notices below it.
 *
 * It follows what arrives until the reader scrolls up to read something
 * earlier (issue #242), or, for a reader who chose to stay at the answer's
 * start, holds the question at the top (issue #282). Either way two jumps
 * appear over its lower edge once there is somewhere to go: back to the
 * start of the latest answer, and on to the end, which follows from there.
 */
export function AiTranscriptArea({
  scrollRef,
  errored,
  loading,
  onRetry,
  showIntro,
  messages,
  commandNotice,
  trace,
  streamingMessages,
  streaming,
  notice,
  error,
  conversationId,
  follow,
  runWrites = [],
  activeRunId = null,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  errored: boolean;
  loading: boolean;
  onRetry: () => void;
  showIntro: boolean;
  messages: AiConversationMessage[];
  commandNotice: AiConversationMessage | null;
  /** The run in flight or the one that ended last, thinking and tool calls in order (issue #195). */
  trace: TranscriptTrace | null;
  /** The run's turns the transcript does not carry yet (issue #242). */
  streamingMessages: AiConversationMessage[];
  streaming: boolean;
  notice: string | null;
  error: string | null;
  /** For the questions this chat's runs wait on (issue #140). */
  conversationId: string | null;
  follow: TranscriptFollow;
  /** What each run wrote, for the line under its answer (issue #248). */
  runWrites?: readonly AiRunWrittenPages[];
  activeRunId?: string | null;
}) {
  const t = useTranslations('ai.transcript');
  const after: React.ReactElement[] = [];
  if (!streaming) {
    after.push(<ConversationCheckpoints key="checkpoints" conversationId={conversationId} />);
  }
  if (commandNotice !== null) {
    after.push(<ChatMessage key={commandNotice.id} message={commandNotice} />);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        data-testid="ai-transcript"
        // Takes the focus from a jump button that disappears once it has
        // done its job, so a keyboard is not dropped back to the page.
        tabIndex={-1}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        {errored ? (
          <ErrorState
            title={t('unavailableTitle')}
            description={t('unavailableDescription')}
            onRetry={onRetry}
          />
        ) : loading ? (
          <LoadingState variant="skeleton" rows={4} />
        ) : (
          <>
            {showIntro ? (
              <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
                <SparklesIcon className="size-5 text-muted-foreground" aria-hidden />
                <p className="text-sm font-medium">{t('introTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('introHint')}</p>
              </div>
            ) : null}

            <Transcript
              messages={messages}
              trace={trace}
              after={after}
              streaming={streamingMessages}
              streamingLive={streaming}
              runWrites={runWrites}
              activeRunId={activeRunId}
              conversationId={conversationId}
            />
          </>
        )}

        {notice !== null ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
        {error !== null ? (
          <p
            role="alert"
            // A run's own diagnosis is written in lines (issue #118): the limit
            // that ran out, what the run did, what to change. Without this they
            // run together into one paragraph and the advice is the hardest
            // part to find.
            className="whitespace-pre-line rounded-md border border-destructive-text/40 px-3 py-2 text-xs text-destructive-text"
          >
            {error}
          </p>
        ) : null}
      </div>
      <TranscriptJumps follow={follow} scrollRef={scrollRef} />
    </div>
  );
}

/**
 * The way back once the reader has scrolled away (issue #242). Not part of
 * the log, so a screen reader is not told about it with every answer, and
 * only there while it has somewhere to go.
 */
function TranscriptJumps({
  follow,
  scrollRef,
}: {
  follow: TranscriptFollow;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useTranslations('ai.transcript');
  const jump = (to: () => void) => () => {
    to();
    scrollRef.current?.focus({ preventScroll: true });
  };
  const showStart = !follow.following && follow.answerStartAbove;
  // Staying at the answer's start (issue #282), the transcript is not
  // following and often at its end anyway: then there is nowhere to go.
  const showEnd = !follow.following && !follow.atEnd;
  if (!showStart && !showEnd) return null;

  return (
    <div
      role="group"
      aria-label={t('jumpLabel')}
      className="pointer-events-none absolute right-3 bottom-3 flex flex-col gap-1.5"
    >
      {showStart ? (
        <JumpButton
          label={t('jumpToAnswerStart')}
          testId="ai-jump-answer-start"
          onClick={jump(follow.jumpToAnswerStart)}
        >
          <ArrowUpIcon />
        </JumpButton>
      ) : null}
      {showEnd ? (
        <JumpButton label={t('jumpToEnd')} testId="ai-jump-end" onClick={jump(follow.jumpToEnd)}>
          <ArrowDownIcon />
        </JumpButton>
      ) : null}
    </div>
  );
}

function JumpButton({
  label,
  testId,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="icon"
            aria-label={label}
            data-testid={testId}
            onClick={onClick}
            // Floating over the text, so it is drawn like the other floating
            // controls (DESIGN.md §4): popover surface, strong outline, shadow.
            className="pointer-events-auto rounded-full border-border-strong bg-popover text-foreground shadow-md hover:bg-accent-solid"
          >
            {children}
          </Button>
        }
      />
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}
