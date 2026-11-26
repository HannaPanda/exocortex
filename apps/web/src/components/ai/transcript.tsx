'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AiConversationMessage } from '@exocortex/contracts';

import { ChatMessage } from './chat-message';
import { summaryFollows } from './panel-view';
import { type RunTraceStep } from './run-trace';
import { RunTraceView } from './run-trace-view';

/** A run's thinking and tool calls (issue #195), live or folded after it ended. */
export interface TranscriptTrace {
  runId: string;
  steps: readonly RunTraceStep[];
  live: boolean;
}

export interface TranscriptProps {
  messages: readonly AiConversationMessage[];
  /**
   * The run this tab watched last, or is watching now. Never stored, so only
   * ever that one run.
   */
  trace?: TranscriptTrace | null;
  /** Keyed elements that follow the stored messages: notices, open questions. */
  after?: readonly React.ReactElement[];
  /** The run's turns the transcript does not carry yet (issue #242). */
  streaming?: readonly AiConversationMessage[];
  /** Whether the last of `streaming` is still being written. */
  streamingLive?: boolean;
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
 *
 * Everything is one keyed list (issue #242). The trace stands once, above the
 * run's first stored answer, or after everything stored while the run has
 * none yet; being a sibling of the messages, it keeps its state (folded,
 * scrolled) when it moves there and when the run ends. A turn still arriving
 * comes last and gives way to the stored message that says the same.
 */
export function Transcript({
  messages,
  trace = null,
  after = [],
  streaming = [],
  streamingLive = false,
}: TranscriptProps) {
  const items: React.ReactElement[] = [];
  const traceElement =
    trace === null ? null : (
      <RunTraceView key={`trace:${trace.runId}`} steps={trace.steps} live={trace.live} />
    );
  let tracePlaced = false;

  messages.forEach((message, index) => {
    const next = messages[index + 1] ?? null;
    // A trailing `/clear` has nothing below it yet; the boundary belongs at
    // the end of the transcript, and the next message arrives underneath it.
    const boundary = message.superseded && (next === null || !next.superseded);

    if (
      traceElement !== null &&
      !tracePlaced &&
      message.role === 'assistant' &&
      message.runId === trace?.runId
    ) {
      items.push(traceElement);
      tracePlaced = true;
    }
    items.push(<ChatMessage key={message.id} message={message} />);
    if (boundary) {
      items.push(
        <ContextBoundary
          key={`boundary:${message.id}`}
          summarized={summaryFollows(messages, index + 1)}
        />,
      );
    }
  });

  items.push(...after);
  if (traceElement !== null && !tracePlaced) items.push(traceElement);
  streaming.forEach((message, index) => {
    items.push(
      <ChatMessage
        key={message.id}
        message={message}
        streaming={streamingLive && index === streaming.length - 1}
      />,
    );
  });

  return <>{items}</>;
}

function ContextBoundary({ summarized }: { summarized: boolean }) {
  const t = useTranslations('ai.transcript');
  return (
    <div
      className="flex items-center gap-2 py-1 text-xs text-muted-foreground"
      data-testid="ai-context-boundary"
    >
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span>{summarized ? t('boundarySummarized') : t('boundaryCleared')}</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}
