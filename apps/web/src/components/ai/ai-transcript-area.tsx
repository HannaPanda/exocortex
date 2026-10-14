'use client';

import { SparklesIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type * as React from 'react';

import { type AiConversationMessage } from '@exocortex/contracts';
import { ErrorState, LoadingState } from '@exocortex/ui';

import { ConversationCheckpoints } from '@/components/attention/conversation-checkpoints';

import { ChatMessage } from './chat-message';
import { type FinishedRunTrace, type RunTraceStep } from './run-trace';
import { RunTraceView } from './run-trace-view';
import { Transcript } from './transcript';

/**
 * The scrolling half of the panel: the transcript, whatever the model is doing
 * right now, and the two one-line notices below it.
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
  finishedTrace,
  streamingMessage,
  streaming,
  notice,
  error,
  conversationId,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  errored: boolean;
  loading: boolean;
  onRetry: () => void;
  showIntro: boolean;
  messages: AiConversationMessage[];
  commandNotice: AiConversationMessage | null;
  /** The run in flight, thinking and tool calls in order (issue #195). */
  trace: RunTraceStep[];
  /** The run that ended last, shown folded beside the answer it led to. */
  finishedTrace: FinishedRunTrace | null;
  streamingMessage: AiConversationMessage | null;
  streaming: boolean;
  notice: string | null;
  error: string | null;
  /** For the questions this chat's runs wait on (issue #140). */
  conversationId: string | null;
}) {
  const t = useTranslations('ai.transcript');
  // A run that ended without an answer has no message to stand beside; its
  // trace then stays where the live one was, above the error that explains it.
  const finishedTraceAnswered =
    finishedTrace !== null && messages.some((message) => message.runId === finishedTrace.runId);
  return (
    <div
      ref={scrollRef}
      role="log"
      aria-live="polite"
      className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
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

          <Transcript messages={messages} finishedTrace={finishedTrace} />
          {streaming ? null : <ConversationCheckpoints conversationId={conversationId} />}
          {commandNotice !== null ? <ChatMessage message={commandNotice} /> : null}

          {streaming ? <RunTraceView steps={trace} live /> : null}
          {!streaming && finishedTrace !== null && !finishedTraceAnswered ? (
            <RunTraceView steps={finishedTrace.steps} live={false} />
          ) : null}

          {streamingMessage !== null ? (
            <ChatMessage message={streamingMessage} streaming={streaming} />
          ) : null}
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
  );
}
