'use client';

import { Loader2Icon, SendIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { CHAT_COMMANDS } from '@exocortex/contracts';
import { Button, Textarea } from '@exocortex/ui';

import { CommandHint } from './command-hint';

export interface ChatComposerProps {
  disabled: boolean;
  onSubmit: (content: string) => Promise<void> | void;
  /**
   * `panel` is the box at the foot of the AI panel. `start` is the one-line
   * field on a workspace's start page that begins a new chat (issue #288): the
   * same keys and the same command hints, its own id, so both can be on screen
   * at once.
   */
  variant?: 'panel' | 'start';
}

const VARIANTS = {
  panel: {
    inputId: 'ai-composer-input',
    inputTestId: 'ai-input',
    sendTestId: 'ai-send',
    rows: 2,
    wrapper: 'relative p-2',
    textarea: 'min-h-[3.25rem] resize-none',
  },
  start: {
    inputId: 'chat-start-input',
    inputTestId: 'chat-start-input',
    sendTestId: 'chat-start-send',
    rows: 1,
    wrapper: 'relative',
    textarea: 'max-h-40 min-h-9 resize-none',
  },
} as const;

/** Matches a still-being-typed command word: a leading slash, no whitespace yet. */
const COMMAND_PREFIX_PATTERN = /^\/([a-z]*)$/i;

export function ChatComposer({ disabled, onSubmit, variant = 'panel' }: ChatComposerProps) {
  const t = useTranslations('ai.composer');
  const look = VARIANTS[variant];
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
    // The top border lives on the wrapper in `ai-panel`, so the context chips
    // above sit inside the same bordered block instead of behind a second rule.
    <div className={look.wrapper}>
      <label htmlFor={look.inputId} className="sr-only">
        {variant === 'start' ? t('startLabel') : t('label')}
      </label>

      {matches.length > 0 ? (
        <CommandHint commands={matches} activeIndex={hintIndex} onSelect={applyCommand} />
      ) : null}

      <div className="flex items-end gap-2">
        <Textarea
          id={look.inputId}
          rows={look.rows}
          value={value}
          placeholder={variant === 'start' ? t('startPlaceholder') : t('placeholder')}
          data-testid={look.inputTestId}
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
          className={look.textarea}
        />
        <Button
          size="icon"
          aria-label={t('send')}
          data-testid={look.sendTestId}
          disabled={disabled || sending || value.trim().length === 0}
          onClick={() => void submit()}
        >
          {sending ? <Loader2Icon className="animate-spin" aria-hidden /> : <SendIcon />}
        </Button>
      </div>
    </div>
  );
}
