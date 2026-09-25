'use client';

import { SparklesIcon } from 'lucide-react';
import type * as React from 'react';

import { type AiConversationMessage } from '@exocortex/contracts';
import { ErrorState, LoadingState } from '@exocortex/ui';

import { ChatMessage } from './chat-message';
import { toolActivityLine } from './run-labels';
import { Transcript } from './transcript';
import { type ToolActivityEntry } from './use-ai-run-tracker';

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
          title="Chat nicht verfügbar"
          description="Der Chat konnte nicht geladen werden."
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
