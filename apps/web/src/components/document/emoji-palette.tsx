'use client';

import * as React from 'react';

import { buttonVariants, cn } from '@exocortex/ui';

import { type EmojiEntry, searchEmoji, useEmojiGroups } from '@/lib/emoji-catalog';

import { useRecentSymbols } from './recent-symbols';

/**
 * The scrollable grid of every emoji.
 *
 * One component for both places that offer emoji — the editor's insert menu and
 * the page icon picker — because the two must not drift apart, and because the
 * awkward parts (1,914 buttons, a shortlist that repeats what the full set also
 * has, a search that has to stay flat) are worth solving once.
 *
 * Groups are revealed a couple at a time as the box is scrolled. Rendering all
 * of them costs about two thousand DOM nodes in a popover that is 320 pixels
 * wide, and nobody has ever scrolled from "Smileys" to "Flaggen" in one go.
 */
const GROUPS_AT_FIRST = 4;
const GROUPS_PER_PAGE = 2;
const SCROLL_THRESHOLD_PX = 240;

export interface EmojiPaletteProps {
  query: string;
  /** The emoji currently in use, marked as pressed. */
  selected?: string | null;
  onPick: (char: string) => void;
  /**
   * Prefix for the `data-testid` of every cell, so the two callers keep the ids
   * their tests already use.
   */
  testIdPrefix: string;
  className?: string;
}

export function EmojiPalette({
  query,
  selected = null,
  onPick,
  testIdPrefix,
  className,
}: EmojiPaletteProps) {
  const groups = useEmojiGroups();
  const [recent, remember] = useRecentSymbols('emoji');
  const [visibleGroups, setVisibleGroups] = React.useState(GROUPS_AT_FIRST);

  const needle = query.trim();
  const results = React.useMemo(() => searchEmoji(query, groups), [query, groups]);

  // Reset the reveal whenever the query changes: a fresh list starts at the top.
  const [lastQuery, setLastQuery] = React.useState(needle);
  if (needle !== lastQuery) {
    setLastQuery(needle);
    setVisibleGroups(GROUPS_AT_FIRST);
  }

  /**
   * The groups with every repeat removed.
   *
   * The curated shortlist repeats emoji that also live in one of Unicode's
   * groups. Showing them twice would mean two buttons for one emoji, and two
   * elements under one test id.
   */
  const deduped = React.useMemo(() => {
    const seen = new Set<string>();
    return groups
      .map((group) => {
        const emojis = group.emojis.filter((entry) => !seen.has(entry.char));
        for (const entry of emojis) seen.add(entry.char);
        return { label: group.label, emojis };
      })
      .filter((group) => group.emojis.length > 0);
  }, [groups]);

  /** Recent emoji are stored as bare characters; this is how they get a name. */
  const byChar = React.useMemo(() => {
    const map = new Map<string, EmojiEntry>();
    for (const group of groups) {
      for (const entry of group.emojis) if (!map.has(entry.char)) map.set(entry.char, entry);
    }
    return map;
  }, [groups]);

  const pick = (char: string): void => {
    remember(char);
    onPick(char);
  };

  const cell = (entry: EmojiEntry, testId: string): React.ReactNode => (
    <button
      key={testId}
      type="button"
      aria-label={entry.label}
      title={entry.label}
      aria-pressed={selected === entry.char}
      data-testid={testId}
      onClick={() => pick(entry.char)}
      className={cn(
        // A plain button carrying the Button component's classes rather than the
        // component itself: the grid holds hundreds at once, and each `Button` is
        // a `useRender` call. Same pixels, a fraction of the work.
        buttonVariants({ variant: 'ghost', size: 'icon-sm' }),
        'text-base',
        selected === entry.char && 'bg-accent-strong',
      )}
    >
      {entry.char}
    </button>
  );

  const onScroll = (event: React.UIEvent<HTMLDivElement>): void => {
    const box = event.currentTarget;
    if (box.scrollHeight - box.scrollTop - box.clientHeight > SCROLL_THRESHOLD_PX) return;
    setVisibleGroups((count) => Math.min(count + GROUPS_PER_PAGE, deduped.length));
  };

  return (
    <div className={cn('overflow-y-auto', className)} onScroll={onScroll}>
      {needle.length > 0 ? (
        results.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">Kein Emoji passt dazu.</p>
        ) : (
          <div className="grid grid-cols-8 gap-0.5">
            {results.map((entry) => cell(entry, `${testIdPrefix}-${entry.char}`))}
          </div>
        )
      ) : (
        <>
          {recent.length > 0 ? (
            <div>
              <p className="px-1 py-1 text-xs font-medium text-muted-foreground">
                Zuletzt verwendet
              </p>
              <div className="grid grid-cols-8 gap-0.5">
                {recent.map((char) =>
                  cell(
                    byChar.get(char) ?? { char, label: char, keywords: [] },
                    `${testIdPrefix}-recent-${char}`,
                  ),
                )}
              </div>
            </div>
          ) : null}

          {deduped.slice(0, visibleGroups).map((group) => (
            <div key={group.label}>
              <p className="px-1 py-1 text-xs font-medium text-muted-foreground">{group.label}</p>
              <div className="grid grid-cols-8 gap-0.5">
                {group.emojis.map((entry) => cell(entry, `${testIdPrefix}-${entry.char}`))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
