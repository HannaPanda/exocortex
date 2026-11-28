'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { cn } from '@exocortex/ui';

import { type EmojiEntry, exactEmoji, searchEmoji, useEmojiGroups } from '@/lib/emoji-catalog';

import { useRecentSymbols } from './recent-symbols';

/**
 * How many emoji the `:` list offers. It scrolls, but a list is read from the
 * top: whoever has not found it in thirty types another letter.
 */
const MAX_EMOJI_SUGGESTIONS = 30;

export interface EmojiSuggestions {
  /** The emoji matching the query, best first; empty while nothing is typed. */
  entries: readonly EmojiEntry[];
  /** The emoji a complete shortcode names, for a closing `:`. */
  exact: (query: string) => EmojiEntry | null;
  /** Records a pick, so the palette lists it under "recently used". */
  remember: (char: string) => void;
}

/**
 * The emoji the `:` menus of the editor and the chat field offer (issue #269).
 *
 * The same catalogue, search and recent list as the palette, so a pick here is
 * a pick there. The full set is only requested once a shortcode is being typed
 * (`query` not `null`): both fields mount this with every page and every chat,
 * and most of them never see a colon.
 */
export function useEmojiSuggestions(query: string | null): EmojiSuggestions {
  const groups = useEmojiGroups({ load: query !== null });
  const [, remember] = useRecentSymbols('emoji');
  const entries = React.useMemo(
    () => (query === null ? [] : searchEmoji(query, groups, MAX_EMOJI_SUGGESTIONS)),
    [groups, query],
  );
  const exact = React.useCallback((typed: string) => exactEmoji(typed, groups), [groups]);
  return { entries, exact, remember };
}

/**
 * Whether the highlight was moved by hand for the current query, reset when
 * the query changes like the highlight itself. Read by `enterChoosesEmoji`.
 */
export function useHighlightMoved(query: string | null): {
  moved: boolean;
  markMoved: () => void;
} {
  const [state, setState] = React.useState({ query, moved: false });
  const moved = state.query === query && state.moved;
  const markMoved = React.useCallback(() => setState({ query, moved: true }), [query]);
  return { moved, markMoved };
}

/** The id of one option, for `aria-activedescendant` and the scroll helper. */
export function emojiOptionId(idPrefix: string, index: number): string {
  return `${idPrefix}-${index}`;
}

/**
 * The list itself, one row per emoji with its name, the same in both places.
 * A row is chosen on `mousedown`, before the field would lose the caret.
 */
export function EmojiSuggestionList({
  entries,
  activeIndex,
  idPrefix,
  onChoose,
  listRef,
  className,
}: {
  entries: readonly EmojiEntry[];
  activeIndex: number;
  idPrefix: string;
  onChoose: (index: number) => void;
  listRef?: React.Ref<HTMLDivElement>;
  className?: string;
}) {
  const t = useTranslations('editor.emojiMenu');
  return (
    <div
      ref={listRef}
      id={`${idPrefix}-list`}
      role="listbox"
      aria-label={t('suggestions')}
      data-testid="emoji-suggestions"
      className={cn(
        'w-64 overflow-y-auto overscroll-contain rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md',
        className,
      )}
    >
      {entries.map((entry, index) => (
        <div
          key={entry.char}
          id={emojiOptionId(idPrefix, index)}
          role="option"
          aria-selected={index === activeIndex}
          data-testid={`emoji-suggestion-${entry.char}`}
          className={cn(
            'flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
            index === activeIndex && 'bg-accent-strong text-foreground',
          )}
          onMouseDown={(event) => {
            event.preventDefault();
            onChoose(index);
          }}
        >
          <span className="w-5 shrink-0 text-center text-base leading-none" aria-hidden>
            {entry.char}
          </span>
          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
        </div>
      ))}
    </div>
  );
}
