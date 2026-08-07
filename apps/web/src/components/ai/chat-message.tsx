'use client';

import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import * as React from 'react';

import { type AiConversationMessage } from '@exocortex/contracts';
import { Badge, cn, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

import { ChatMarkdown, CopyMarkdownButton } from './chat-markdown';

export interface ChatMessageProps {
  message: AiConversationMessage;
  /** True while this is the trailing, not-yet-persisted assistant reply. */
  streaming?: boolean;
}

/**
 * One bubble for all four conversation roles (`user`, `assistant`, `system`,
 * `tool`). Assistant content and summaries (`isSummary`) are model text and
 * are rendered as the chat's limited Markdown subset (issue #21, see
 * `chat-markdown.tsx`); a user's own message stays plain text, and a tool
 * result stays monospace -- neither is prose the model formatted.
 */
export function ChatMessage({ message, streaming = false }: ChatMessageProps) {
  const body = (
    <ChatMessageBody message={message} streaming={streaming} />
  );

  if (!message.superseded) return body;

  return (
    <Tooltip>
      <TooltipTrigger render={<div className="opacity-60">{body}</div>} />
      <TooltipContent>Nicht mehr Teil des Kontexts.</TooltipContent>
    </Tooltip>
  );
}

function ChatMessageBody({ message, streaming }: ChatMessageProps) {
  switch (message.role) {
    case 'user':
      return (
        <div className="flex justify-end">
          <p
            data-testid="ai-question"
            className="max-w-[85%] rounded-md bg-primary px-3 py-2 text-sm whitespace-pre-wrap break-words text-primary-foreground"
          >
            {message.content}
          </p>
        </div>
      );

    case 'assistant':
      return (
        <div className="group/message flex justify-start">
          <div className="flex max-w-[85%] flex-col items-start gap-1">
            <div data-testid="ai-answer" className="rounded-md bg-muted px-3 py-2 text-sm break-words">
              <ChatMarkdown content={message.content} streaming={streaming} />
              {streaming ? (
                <span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse bg-primary align-middle" />
              ) : null}
            </div>
            {message.content.length > 0 ? (
              <div className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100">
                <CopyMarkdownButton markdown={message.content} />
              </div>
            ) : null}
          </div>
        </div>
      );

    case 'system':
      return <SystemMessage message={message} />;

    case 'tool':
      return <ToolMessage message={message} />;

    default:
      return null;
  }
}

function SystemMessage({ message }: { message: AiConversationMessage }) {
  const [expanded, setExpanded] = React.useState(!message.isSummary);

  if (!message.isSummary) {
    return (
      <p className="border-l-2 border-border pl-2 text-xs text-muted-foreground">
        {message.content}
      </p>
    );
  }

  return (
    <div className="border-l-2 border-border pl-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <Badge variant="muted">Zusammenfassung</Badge>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
          Verlauf anzeigen
        </button>
        {expanded ? <CopyMarkdownButton markdown={message.content} /> : null}
      </div>
      {expanded ? (
        <div className="mt-1">
          <ChatMarkdown content={message.content} />
        </div>
      ) : null}
    </div>
  );
}

function ToolMessage({ message }: { message: AiConversationMessage }) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="font-mono text-xs">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        {message.toolName ?? 'Werkzeug'}: Werkzeugergebnis anzeigen
      </button>
      {expanded ? (
        <p className={cn('mt-1 rounded-md border border-border bg-card p-2 whitespace-pre-wrap break-words')}>
          {message.content}
        </p>
      ) : null}
    </div>
  );
}
