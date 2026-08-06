'use client';

import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import * as React from 'react';

import { type AiConversationMessage } from '@exocortex/contracts';
import { Badge, cn,Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

export interface ChatMessageProps {
  message: AiConversationMessage;
  /** True while this is the trailing, not-yet-persisted assistant reply. */
  streaming?: boolean;
}

/**
 * One bubble for all four conversation roles (`user`, `assistant`, `system`,
 * `tool`). Assistant content is rendered as plain text with preserved
 * whitespace; a Markdown renderer is a deliberately deferred follow-up (see
 * the commit message), not an oversight.
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
        <div className="flex justify-start">
          <p
            data-testid="ai-answer"
            className="max-w-[85%] rounded-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words"
          >
            {message.content}
            {streaming ? (
              <span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse bg-primary align-middle" />
            ) : null}
          </p>
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
      </div>
      {expanded ? <p className="mt-1 whitespace-pre-wrap break-words">{message.content}</p> : null}
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
