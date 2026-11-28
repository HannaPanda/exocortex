'use client';

import { Loader2Icon, PaperclipIcon, SendIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { CHAT_COMMANDS } from '@exocortex/contracts';
import { Button, Textarea, Tooltip, TooltipContent, TooltipTrigger } from '@exocortex/ui';

import { CommandHint } from './command-hint';
import { CHAT_FILE_INPUT_ACCEPT } from './use-chat-attachments';
import { useComposerEmoji } from './use-composer-emoji';

export interface ChatComposerProps {
  /**
   * A message cannot go out now: a run is answering, or a summary asked for
   * with `/compact` is being written. Only sending waits. The field itself
   * stays writable and keeps the cursor (issue #301): a disabled field drops
   * its focus, and the next question could then not be typed until somebody
   * clicked back into it.
   */
  waiting: boolean;
  /**
   * `keepFocus` says whether the cursor stayed in the field (`keepsFocusAfter`),
   * for a caller that moves the conversation somewhere else and the cursor with
   * it, as the start page does.
   */
  onSubmit: (content: string, sent: { keepFocus: boolean }) => Promise<void> | void;
  /**
   * Bumped by whoever wants the cursor in this field: the panel, when a
   * question begun on the start page arrives in it (issue #301).
   */
  focusRequest?: number;
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

/** How a message was sent: the Enter key, or the send button and what pressed it. */
export type SendGesture = 'enter' | 'button' | 'button-touch';

/**
 * Whether the cursor stays in the field once a message is sent (issue #301).
 *
 * Enter and a click keep it, so a follow-up can be typed straight away. A
 * finger on the send button lets it go: on a phone the field holding the
 * cursor is what keeps the on-screen keyboard open, and that keyboard covers
 * half of the answer about to arrive. Tapping send is where a person on a
 * phone stops typing and starts reading, and a keyboard that comes back by
 * itself after it was put away is the thing not to do. Whoever sends with the
 * keyboard's own Enter is still typing, so the keyboard stays.
 */
export function keepsFocusAfter(gesture: SendGesture): boolean {
  return gesture !== 'button-touch';
}

export function ChatComposer({
  waiting,
  onSubmit,
  variant = 'panel',
  files,
  focusRequest = 0,
}: ChatComposerProps) {
  const t = useTranslations('ai.composer');
  const look = VARIANTS[variant];
  const [value, setValue] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [hintIndex, setHintIndex] = React.useState(0);
  const [hintDismissed, setHintDismissed] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  // Where the caret is, for the `:` menu (issue #269); `null` over a selection.
  const [caret, setCaret] = React.useState<number | null>(null);
  // What pressed the send button last, read by its click: a click carries no
  // pointer type in every browser, the pointerdown before it does.
  const pressedWith = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (focusRequest > 0) textareaRef.current?.focus();
  }, [focusRequest]);

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

  const emoji = useComposerEmoji({
    value,
    caret,
    textareaRef,
    onChange: (next, at) => {
      setValue(next);
      setCaret(at);
      // The new text is not in the field until React has rendered it.
      requestAnimationFrame(() => textareaRef.current?.setSelectionRange(at, at));
    },
  });

  const applyCommand = (name: string): void => {
    setValue(`/${name} `);
    setHintDismissed(true);
    textareaRef.current?.focus();
  };

  const content = value.trim();
  const canSend = !waiting && !sending && hasSomethingToSend(content, files);

  const submit = async (gesture: SendGesture): Promise<void> => {
    if (!canSend) return;
    const keepFocus = keepsFocusAfter(gesture);
    // The button, pressed from the keyboard, empties and so disables itself,
    // which would drop the focus on the page; the field takes it instead.
    if (keepFocus) textareaRef.current?.focus();
    else textareaRef.current?.blur();
    setSending(true);
    setValue('');
    try {
      await onSubmit(content, { keepFocus });
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
      {emoji.element}

      <div className="flex items-end gap-2">
        <Textarea
          id={look.inputId}
          rows={look.rows}
          value={value}
          placeholder={variant === 'start' ? t('startPlaceholder') : t('placeholder')}
          data-testid={look.inputTestId}
          {...emoji.fieldProps}
          onChange={(event) => {
            setValue(event.target.value);
            setCaret(caretOf(event.target));
          }}
          onSelect={(event) => setCaret(caretOf(event.currentTarget))}
          onPaste={(event) => pasteFiles(event, files)}
          ref={textareaRef}
          onKeyDown={(event) => {
            if (emoji.onKeyDown(event)) return;
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
                // Not the sheet around the chat as well, on a phone (#301):
                // see `use-composer-emoji.tsx` for why it takes both stops.
                event.stopPropagation();
                event.nativeEvent.stopImmediatePropagation();
                setHintDismissed(true);
                return;
              }
            }

            if (event.key === 'Enter' && !event.shiftKey) {
              // While a message cannot go out, Enter keeps what was typed and
              // waits, rather than adding a line to it.
              event.preventDefault();
              void submit('enter');
            }
          }}
          className={look.textarea}
        />
        {files === undefined ? null : (
          <ComposerAttachButton files={files} disabled={waiting || sending} />
        )}
        <Button
          size="icon"
          aria-label={t('send')}
          data-testid={look.sendTestId}
          disabled={!canSend}
          onPointerDown={(event) => {
            pressedWith.current = event.pointerType;
          }}
          // A press would move the focus onto the button for the moment of the
          // click; the field keeps it instead (the default of mousedown, not of
          // pointerdown, is what moves it).
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            const touched = pressedWith.current === 'touch' || pressedWith.current === 'pen';
            pressedWith.current = null;
            void submit(touched ? 'button-touch' : 'button');
          }}
        >
          {sending ? <Loader2Icon className="animate-spin" aria-hidden /> : <SendIcon />}
        </Button>
      </div>
    </div>
  );
}

/** The caret of a field, or `null` while a range is selected. */
function caretOf(field: HTMLTextAreaElement): number | null {
  return field.selectionStart === field.selectionEnd ? field.selectionStart : null;
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
