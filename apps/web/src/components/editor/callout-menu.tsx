'use client';

import { type EditorView } from '@tiptap/pm/view';
import { type Editor, type EditorEvents } from '@tiptap/react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  CALLOUT_COLORS,
  CALLOUT_EDIT_EVENT,
  type CalloutColor,
  type CalloutCommandAttributes,
  type CalloutEditEventDetail,
  resolveCallout,
  updateCalloutAt,
} from '@exocortex/editor';
import {
  cn,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTitle,
  Toggle,
  ToggleGroup,
} from '@exocortex/ui';

import { EmojiPalette } from '@/components/document/emoji-palette';

import { useMountedView } from './code-block-toolbar';

/**
 * The headings offered for a callout, as keys of `editor.callout.suggestions`.
 * GitLab's alert titles, in the order a writer reaches for them; any other
 * heading is typed.
 */
const TITLE_SUGGESTIONS = ['note', 'tip', 'important', 'caution', 'warning'] as const;

/**
 * The frame of each colour swatch, written out because Tailwind only emits the
 * classes it can see in the source.
 */
const SWATCH_FRAME: Readonly<Record<CalloutColor, string>> = {
  default: 'border-border',
  gray: 'border-content-gray',
  brown: 'border-content-brown',
  orange: 'border-content-orange',
  yellow: 'border-content-yellow',
  green: 'border-content-green',
  blue: 'border-content-blue',
  purple: 'border-content-purple',
  pink: 'border-content-pink',
  red: 'border-content-red',
};

interface OpenCallout {
  /** Where the callout stands, kept in step with the document while the menu is open. */
  pos: number;
  part: CalloutEditEventDetail['part'];
  anchor: HTMLElement;
}

/** The callout the caret is in, unless a code block inside it is nearer. */
function calloutAtCaret(editor: Editor): number | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const name = $from.node(depth).type.name;
    // The code block has its own bar, and Tab there goes to it (#304).
    if (name === 'codeBlock') return null;
    if (name === 'callout') return $from.before(depth);
  }
  return null;
}

/** The symbol button of the callout at `pos`, or `null`. */
function symbolButtonAt(view: EditorView, pos: number): HTMLButtonElement | null {
  if (view.state.doc.nodeAt(pos)?.type.name !== 'callout') return null;
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement
    ? dom.querySelector<HTMLButtonElement>(':scope > [data-callout-emoji]')
    : null;
}

/**
 * The menu behind a callout's symbol (issue #306): symbol, heading and colour.
 *
 * The box itself is drawn by `packages/editor` (`callout.ts`), which knows no
 * React; a press on its symbol or its heading sends `CALLOUT_EDIT_EVENT`, and
 * this opens the menu against the symbol. From the keyboard, `Tab` in the text
 * of a callout goes to its symbol, the way it goes to a code block's bar
 * (#304); `Enter` opens the menu, and `Escape` or `Shift + Tab` go back to the
 * text.
 *
 * Every change is written at once, as an ordinary edit of the callout's
 * attributes, so it reaches the other people on the page and is undone with
 * `Strg + Z` like any other.
 */
export function CalloutMenu({ editor }: { editor: Editor }) {
  const t = useTranslations('editor.callout');
  const colorName = useTranslations('editor.colors.name');
  const view = useMountedView(editor);
  const [open, setOpen] = React.useState<OpenCallout | null>(null);
  const [query, setQuery] = React.useState('');
  /**
   * The heading as it is being typed. The stored one is trimmed, so a field
   * bound to it would swallow the space between two words while they are
   * typed.
   */
  const [titleDraft, setTitleDraft] = React.useState('');
  const titleRef = React.useRef<HTMLInputElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const titleId = React.useId();
  const colorLabelId = React.useId();
  const suggestionLabelId = React.useId();
  const searchId = React.useId();

  // A press on a symbol or a heading opens the menu for that callout.
  React.useEffect(() => {
    if (view === null) return undefined;
    const edit = (event: Event): void => {
      if (!(event instanceof CustomEvent) || !editor.isEditable) return;
      const detail = event.detail as CalloutEditEventDetail;
      setQuery('');
      const opened = editor.state.doc.nodeAt(detail.pos);
      setTitleDraft(opened === null ? '' : (resolveCallout(opened.attrs).title ?? ''));
      setOpen({ pos: detail.pos, part: detail.part, anchor: detail.anchor });
    };
    view.dom.addEventListener(CALLOUT_EDIT_EVENT, edit);
    return () => view.dom.removeEventListener(CALLOUT_EDIT_EVENT, edit);
  }, [view, editor]);

  // `Tab` in a callout's text goes to its symbol. Registered after
  // ProseMirror's own handler, so a list item that indents, a table that moves
  // to its next cell or a list that continues below (#240) has already taken
  // the key and marked it.
  React.useEffect(() => {
    if (view === null) return undefined;
    const tab = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (event.defaultPrevented || !editor.isEditable) return;
      const pos = calloutAtCaret(editor);
      if (pos === null) return;
      const button = symbolButtonAt(view, pos);
      if (button === null) return;
      event.preventDefault();
      button.focus();
    };
    view.dom.addEventListener('keydown', tab);
    return () => view.dom.removeEventListener('keydown', tab);
  }, [view, editor]);

  // The callout moves when something above it changes; one that is deleted
  // while the menu is open closes it.
  React.useEffect(() => {
    if (open === null) return undefined;
    const follow = ({ transaction }: EditorEvents['transaction']): void => {
      if (!transaction.docChanged) return;
      setOpen((current) => {
        if (current === null) return null;
        const mapped = transaction.mapping.mapResult(current.pos);
        if (mapped.deleted) return null;
        return mapped.pos === current.pos ? current : { ...current, pos: mapped.pos };
      });
    };
    editor.on('transaction', follow);
    return () => {
      editor.off('transaction', follow);
    };
  }, [editor, open]);

  const node = open === null ? null : editor.state.doc.nodeAt(open.pos);
  const callout = node?.type.name === 'callout' ? resolveCallout(node.attrs) : null;

  const change = (attributes: CalloutCommandAttributes): void => {
    if (open === null) return;
    const { tr } = editor.state;
    if (updateCalloutAt(tr, open.pos, attributes)) editor.view.dispatch(tr);
  };

  const close = (backToText: boolean): void => {
    setOpen(null);
    setQuery('');
    if (backToText) editor.commands.focus();
  };

  const setTitle = (value: string): void => {
    setTitleDraft(value);
    change({ title: value });
  };

  const title = callout?.title ?? '';
  const color: CalloutColor = callout?.color ?? 'default';
  const suggestions = TITLE_SUGGESTIONS.map((key) => t(`suggestions.${key}`));

  return (
    <Popover
      open={open !== null && callout !== null}
      onOpenChange={(next, details) => {
        // A press elsewhere on the page keeps the focus where it went.
        if (!next) close(details.reason !== 'outside-press');
      }}
    >
      <PopoverContent
        anchor={open?.anchor}
        align="start"
        className="flex w-80 flex-col gap-3"
        data-testid="callout-menu"
        initialFocus={open?.part === 'title' ? titleRef : searchRef}
        finalFocus={false}
      >
        <PopoverTitle className="sr-only">{t('menuTitle')}</PopoverTitle>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={titleId}>{t('title')}</Label>
          <Input
            ref={titleRef}
            id={titleId}
            value={titleDraft}
            placeholder={t('titlePlaceholder')}
            data-testid="callout-title-input"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                close(true);
              }
            }}
          />
          <span id={suggestionLabelId} className="sr-only">
            {t('suggestionsLabel')}
          </span>
          <ToggleGroup
            aria-labelledby={suggestionLabelId}
            className="flex-wrap"
            value={suggestions.includes(title) ? [title] : []}
            onValueChange={(next) => {
              const [picked] = next as string[];
              setTitle(picked ?? '');
            }}
          >
            {suggestions.map((suggestion, index) => (
              <Toggle
                key={TITLE_SUGGESTIONS[index]}
                value={suggestion}
                variant="outline"
                size="sm"
                data-testid={`callout-title-${TITLE_SUGGESTIONS[index]}`}
              >
                {suggestion}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>

        <div className="flex flex-col gap-1.5">
          {/* The name of the chosen colour is written out, never shown by the
              swatch alone (WCAG 1.4.1). */}
          <span id={colorLabelId} className="text-sm font-medium">
            {t('color', { name: colorName(color) })}
          </span>
          <ToggleGroup
            aria-labelledby={colorLabelId}
            className="flex-wrap"
            value={[color]}
            onValueChange={(next) => {
              const [picked] = next as CalloutColor[];
              // Pressing the chosen colour again leaves it chosen.
              if (picked !== undefined) change({ color: picked });
            }}
          >
            {CALLOUT_COLORS.map((name) => (
              <Toggle
                key={name}
                value={name}
                size="sm"
                aria-label={colorName(name)}
                title={colorName(name)}
                data-testid={`callout-color-${name}`}
              >
                <span
                  aria-hidden
                  className={cn('size-4 rounded-sm border-2 bg-card', SWATCH_FRAME[name])}
                />
              </Toggle>
            ))}
          </ToggleGroup>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={searchId}>{t('emoji', { emoji: callout?.emoji ?? '' })}</Label>
          <Input
            ref={searchRef}
            id={searchId}
            value={query}
            placeholder={t('emojiSearch')}
            data-testid="callout-emoji-search"
            onChange={(event) => setQuery(event.target.value)}
          />
          {/* Mounted only while open, like the editor's emoji menu: the full
              set is loaded on first use. */}
          {open !== null ? (
            <EmojiPalette
              query={query}
              selected={callout?.emoji ?? null}
              testIdPrefix="callout-emoji"
              className="max-h-56"
              onPick={(emoji) => {
                change({ emoji });
                close(true);
              }}
            />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
