'use client';

import { Loader2Icon, SendIcon } from 'lucide-react';
import * as React from 'react';

import { CHAT_COMMANDS } from '@exocortex/contracts';
import { Button, Textarea } from '@exocortex/ui';

import { CommandHint } from './command-hint';

export interface ChatComposerProps {
  disabled: boolean;
  onSubmit: (content: string) => Promise<void> | void;
}

/** Matches a still-being-typed command word: a leading slash, no whitespace yet. */
const COMMAND_PREFIX_PATTERN = /^\/([a-z]*)$/i;

export function ChatComposer({ disabled, onSubmit }: ChatComposerProps) {
  const [value, setValue] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [hintIndex, setHintIndex] = React.useState(0);
  const [hintDismissed, setHintDismissed] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);

  const prefixMatch = COMMAND_PREFIX_PATTERN.exec(value);
  const commandQuery = prefixMatch?.[1]?.toLowerCase() ?? null;

  // Reset the selection whenever the typed command word changes. Adjusted
  // during render (React's documented reset-on-change pattern) instead of in
  // an effect, so there is no extra committed render with a stale index.
  const [lastCommandQuery, setLastCommandQuery] = React.useState(commandQuery);
  if (lastCommandQuery !== commandQuery) {
    setLastCommandQuery(commandQuery);
    setHintIndex(0);
    setHintDismissed(false);
  }

  const matches =
    commandQuery === null || hintDismissed
      ? []
      : CHAT_COMMANDS.filter((command) => command.name.startsWith(commandQuery));

  const applyCommand = (name: string): void => {
    setValue(`/${name} `);
    setHintDismissed(true);
    textareaRef.current?.focus();
  };

  const submit = async (): Promise<void> => {
    const content = value.trim();
    if (content.length === 0 || disabled || sending) return;
    setSending(true);
    setValue('');
    try {
      await onSubmit(content);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="relative border-t border-border p-2">
      <label htmlFor="ai-composer-input" className="sr-only">
        Nachricht an die KI
      </label>

      {matches.length > 0 ? (
        <CommandHint commands={matches} activeIndex={hintIndex} onSelect={applyCommand} />
      ) : null}

      <div className="flex items-end gap-2">
        <Textarea
          id="ai-composer-input"
          rows={2}
          value={value}
          placeholder="Frage stellen oder /help für Befehle …"
          data-testid="ai-input"
          disabled={disabled || sending}
          onChange={(event) => setValue(event.target.value)}
          ref={textareaRef}
          onKeyDown={(event) => {
            if (matches.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setHintIndex((current) => (current + 1) % matches.length);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setHintIndex((current) => (current - 1 + matches.length) % matches.length);
                return;
              }
              if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                event.preventDefault();
                const chosen = matches[hintIndex] ?? matches[0];
                if (chosen !== undefined) applyCommand(chosen.name);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setHintDismissed(true);
                return;
              }
            }

            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          className="min-h-[3.25rem] resize-none"
        />
        <Button
          size="icon"
          aria-label="Frage senden"
          data-testid="ai-send"
          disabled={disabled || sending || value.trim().length === 0}
          onClick={() => void submit()}
        >
          {sending ? <Loader2Icon className="animate-spin" aria-hidden /> : <SendIcon />}
        </Button>
      </div>
    </div>
  );
}
