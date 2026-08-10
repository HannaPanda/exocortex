'use client';

import * as React from 'react';

import { type AiConversationMessage } from '@exocortex/contracts';

import { ChatMessage } from './chat-message';

export interface TranscriptProps {
  messages: readonly AiConversationMessage[];
}

/**
 * The conversation, with its context boundaries drawn where they really are.
 *
 * A message that has dropped out of the context carries `superseded`. The
 * place where that flag stops being set *is* the cut, so the marker is derived
 * from the persisted transcript instead of being collected in local state
 * (issue #25): it cannot sit in the wrong place, it cannot stack up over
 * repeated calls, and it survives a reload -- unlike the client-side notice
 * that used to stand in for it.
 *
 * Two things cut the context and they read differently. `/clear` empties it
 * outright; the automatic compaction replaces the older messages with a
 * summary, which is how it is told apart here: the first message below such a
 * boundary is that summary.
 */
export function Transcript({ messages }: TranscriptProps) {
  return (
    <>
      {messages.map((message, index) => {
        const next = messages[index + 1] ?? null;
        // A trailing `/clear` has nothing below it yet; the boundary belongs at
        // the end of the transcript, and the next message arrives underneath it.
        const boundary = message.superseded && (next === null || !next.superseded);

        return (
          <React.Fragment key={message.id}>
            <ChatMessage message={message} />
            {boundary ? <ContextBoundary summarized={next?.isSummary ?? false} /> : null}
          </React.Fragment>
        );
      })}
    </>
  );
}

function ContextBoundary({ summarized }: { summarized: boolean }) {
  return (
    <div
      className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
      data-testid="ai-context-boundary"
    >
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span>{summarized ? 'Älterer Verlauf zusammengefasst' : 'Kontext geleert'}</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}
