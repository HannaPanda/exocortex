'use client';

import { Loader2Icon, PaperclipIcon, SendIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { CHAT_COMMANDS } from '@exocortex/contracts';
import { Button, Textarea, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

import { CommandHint } from './command-hint';
import { CHAT_FILE_INPUT_ACCEPT } from './use-chat-attachments';

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
  /**
   * Pictures for the next message (issue #223): the composer takes them from
   * the clipboard and the file picker and hands them on. Absent, it takes none.
   */
  files?: ComposerFiles;
}

export interface ComposerFiles {
  onFiles: (files: File[]) => void;
  /** Pictures are ready to go: a message may then be sent without words. */
  ready: boolean;
  /** A picture is still uploading, and sending now would leave it behind. */
  uploading: boolean;
}

/** Whatever files a clipboard or a drop carries. */
export function filesOf(data: DataTransfer | null): File[] {
  if (data === null) return [];
  return Array.from(data.files);
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

export function ChatComposer({ disabled, onSubmit, variant = 'panel', files }: ChatComposerProps) {
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

  const content = value.trim();
  const canSend = !disabled && !sending && hasSomethingToSend(content, files);

  const submit = async (): Promise<void> => {
    if (!canSend) return;
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
          onPaste={(event) => pasteFiles(event, files)}
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
        {files === undefined ? null : (
          <ComposerAttachButton files={files} disabled={disabled || sending} />
        )}
        <Button
          size="icon"
          aria-label={t('send')}
          data-testid={look.sendTestId}
          disabled={!canSend}
          onClick={() => void submit()}
        >
          {sending ? <Loader2Icon className="animate-spin" aria-hidden /> : <SendIcon />}
        </Button>
      </div>
    </div>
  );
}

/**
 * Words, or pictures without words; never while a picture is still uploading,
 * since the message would then leave it behind.
 */
function hasSomethingToSend(content: string, files: ComposerFiles | undefined): boolean {
  if (files?.uploading === true) return false;
  return content.length > 0 || files?.ready === true;
}

/**
 * A screenshot in the clipboard often comes with its file name as text; the
 * picture is what was meant, so a paste that carries files inserts no text.
 */
function pasteFiles(
  event: React.ClipboardEvent<HTMLTextAreaElement>,
  files: ComposerFiles | undefined,
): void {
  if (files === undefined) return;
  const pasted = filesOf(event.clipboardData);
  if (pasted.length === 0) return;
  event.preventDefault();
  files.onFiles(pasted);
}

/** The file picker for pictures (issue #223): a hidden input behind an icon button. */
function ComposerAttachButton({ files, disabled }: { files: ComposerFiles; disabled: boolean }) {
  const t = useTranslations('ai.composer');
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={CHAT_FILE_INPUT_ACCEPT}
        multiple
        hidden
        data-testid="ai-attach-input"
        onChange={(event) => {
          files.onFiles(Array.from(event.target.files ?? []));
          // The same picture chosen twice in a row is still a choice.
          event.target.value = '';
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('attach')}
              data-testid="ai-attach"
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              <PaperclipIcon />
            </Button>
          }
        />
        <TooltipContent>{t('attachHint')}</TooltipContent>
      </Tooltip>
    </>
  );
}
