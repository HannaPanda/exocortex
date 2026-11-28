'use client';

import * as React from 'react';

import {
  emojiOptionId,
  EmojiSuggestionList,
  useEmojiSuggestions,
  useHighlightMoved,
} from '@/components/document/emoji-suggestions';
import { useActiveOptionInView, useSuggestionHighlight } from '@/components/editor/suggestion-menu';
import { emojiQueryBefore, enterChoosesEmoji } from '@/lib/emoji-shortcode';

export interface ComposerEmoji {
  /** The list above the field, or `null` while it is closed. */
  element: React.ReactNode;
  /** Handles a key while the list is open; `true` when it was the list's. */
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** What the field announces about the list while it is open. */
  fieldProps: {
    'aria-controls'?: string;
    'aria-activedescendant'?: string;
  };
}

/**
 * The `:` menu of the chat field (issue #269): the editor's, for a plain
 * textarea.
 *
 * The field is Markdown, so where a colon may open the list is read from the
 * text before the caret (`emojiQueryBefore`), code spans and fences included.
 * Escape closes the list for that one colon and is stopped there: in the
 * phone's sheet it would otherwise close the chat too (#301).
 */
export function useComposerEmoji({
  value,
  caret,
  onChange,
  textareaRef,
}: {
  value: string;
  /** The caret, or `null` while text is selected or the field never had it. */
  caret: number | null;
  /** Sets the field's text and where the caret goes in it. */
  onChange: (next: string, caret: number) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}): ComposerEmoji {
  // Two fields can be on screen at once (the panel and the start page).
  const idPrefix = `composer-emoji-${React.useId()}`;
  const found = caret === null ? null : emojiQueryBefore(value, caret);
  // Escape remembers the colon it closed the list for; another colon opens it,
  // and so does the same one once the shortcode around it is gone.
  const [dismissedAt, setDismissedAt] = React.useState<number | null>(null);
  if (found === null && dismissedAt !== null) setDismissedAt(null);
  const active = found !== null && found.from !== dismissedAt ? found : null;
  const query = active?.query ?? null;

  const { entries, exact, remember } = useEmojiSuggestions(query);
  const { index, setIndex } = useSuggestionHighlight(query);
  const { moved, markMoved } = useHighlightMoved(query);
  const listRef = React.useRef<HTMLDivElement>(null);
  const open = active !== null && entries.length > 0;

  useActiveOptionInView(listRef, open ? emojiOptionId(idPrefix, index) : '');

  const insert = (char: string): void => {
    if (active === null) return;
    remember(char);
    onChange(
      value.slice(0, active.from) + char + value.slice(active.to),
      active.from + char.length,
    );
    textareaRef.current?.focus();
  };

  const choose = (chosen: number): void => {
    const entry = entries[chosen];
    if (entry !== undefined) insert(entry.char);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || active === null || event.nativeEvent.isComposing) return false;
    const take = (): true => {
      event.preventDefault();
      return true;
    };
    switch (event.key) {
      case 'ArrowDown':
        markMoved();
        setIndex((index + 1) % entries.length);
        return take();
      case 'ArrowUp':
        markMoved();
        setIndex((index - 1 + entries.length) % entries.length);
        return take();
      case 'Tab':
        choose(index);
        return take();
      case 'Enter':
        if (event.shiftKey || !enterChoosesEmoji(active.query, moved)) return false;
        choose(index);
        return take();
      case 'Escape':
        setDismissedAt(active.from);
        // The sheet around the chat listens on the document; React's own
        // listener sits there too and runs first, so only an immediate stop
        // keeps the Escape from closing the chat along with the list.
        event.stopPropagation();
        event.nativeEvent.stopImmediatePropagation();
        return take();
      case ':': {
        const named = exact(active.query);
        if (named === null) return false;
        insert(named.char);
        return take();
      }
      default:
        return false;
    }
  };

  const element = open ? (
    <EmojiSuggestionList
      entries={entries}
      activeIndex={index}
      idPrefix={idPrefix}
      onChoose={choose}
      listRef={listRef}
      className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-full"
    />
  ) : null;

  return {
    element,
    onKeyDown,
    fieldProps: open
      ? {
          'aria-controls': `${idPrefix}-list`,
          'aria-activedescendant': emojiOptionId(idPrefix, index),
        }
      : {},
  };
}
