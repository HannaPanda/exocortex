'use client';

import { ChevronRight, Pin, PinOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type PageOutlineEntry } from '@exocortex/editor';
import { Button, cn, SectionRule } from '@exocortex/ui';

import { type RailTick } from './outline-geometry';

/**
 * What the floating outline draws (issue #194), without knowing about the
 * editor: the collapsed scale, the list and its header. The container in
 * `page-outline.tsx` feeds them; `/design-system` draws them from fixtures.
 */

/** A heading as the list shows it: the outline entry and its position in it. */
export interface OutlineRow {
  index: number;
  entry: PageOutlineEntry;
  /** 0 for the page's top heading level. */
  depth: number;
  /** Headings the collapsed section hides, so the row can say what is inside. */
  hiddenCount: number;
}

/**
 * The rows of the list: every heading that is on screen, and a collapsed
 * heading once, with the count of what it hides. A heading inside a collapsed
 * section is not listed, because there is nothing on the page to land on; the
 * section is folded on purpose, and the outline does not unfold it.
 */
export function outlineRows(entries: readonly PageOutlineEntry[]): OutlineRow[] {
  const visible = entries.filter((entry) => entry.hiddenUnder === null);
  const levels = [...new Set(visible.map((entry) => entry.level))].sort((a, b) => a - b);
  const hidden = new Map<string, number>();
  for (const entry of entries) {
    if (entry.hiddenUnder === null) continue;
    hidden.set(entry.hiddenUnder, (hidden.get(entry.hiddenUnder) ?? 0) + 1);
  }
  return entries.flatMap((entry, index) =>
    entry.hiddenUnder === null
      ? [
          {
            index,
            entry,
            depth: levels.indexOf(entry.level),
            hiddenCount: entry.blockId === null ? 0 : (hidden.get(entry.blockId) ?? 0),
          },
        ]
      : [],
  );
}

/** Stroke widths by depth: a scale reads its structure from length alone. */
const TICK_WIDTH = ['w-4', 'w-3', 'w-2', 'w-1.5'] as const;

/**
 * The collapsed outline: one stroke per heading, the current one in amber.
 *
 * Strokes in `signal-line` are structure, the amber one is "you are here", so
 * the scale is the same instrument mark the page tree's guides are made of. It
 * is one control, not a row of tiny targets: the strokes are 2px tall and a
 * pointer could not hit one of them reliably, and a keyboard would have to
 * tab through thirty stops to get past it.
 */
export function OutlineRail({
  ticks,
  activeTick,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  ticks: readonly RailTick[];
  activeTick: number | null;
}) {
  return (
    <button
      type="button"
      data-testid="page-outline-rail"
      className={cn(
        'group/rail pointer-events-auto flex w-8 flex-col items-end gap-1 rounded-md px-2 py-2.5',
        'transition-colors hover:bg-accent-solid aria-expanded:bg-accent-solid',
        className,
      )}
      {...props}
    >
      {ticks.map((tick, position) => (
        <span
          key={tick.index}
          aria-hidden
          data-active={position === activeTick ? 'true' : undefined}
          className={cn(
            'h-0.5 shrink-0 rounded-full bg-signal-line transition-colors',
            TICK_WIDTH[Math.min(tick.depth, TICK_WIDTH.length - 1)],
            'group-hover/rail:bg-border-strong',
            'data-active:bg-primary group-hover/rail:data-active:bg-primary',
          )}
        />
      ))}
    </button>
  );
}

/**
 * The label above the list, with the pin control where pinning is possible.
 * No count: the list beneath says how long it is, and in the pinned column
 * the number cost the label its last letters.
 */
export function OutlineHeader({
  pinned,
  canPin,
  onPinnedChange,
}: {
  pinned: boolean;
  canPin: boolean;
  onPinnedChange: (pinned: boolean) => void;
}) {
  const t = useTranslations('editor.pageOutline');
  return (
    <SectionRule
      as="h2"
      className="min-h-7 px-2"
      action={
        canPin || pinned ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={pinned ? t('unpin') : t('pin')}
            title={pinned ? t('unpin') : t('pin')}
            aria-pressed={pinned}
            data-testid="page-outline-pin"
            onClick={() => onPinnedChange(!pinned)}
          >
            {pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </Button>
        ) : undefined
      }
    >
      {t('label')}
    </SectionRule>
  );
}

/**
 * The list of headings. Arrow keys, Home and End move between them; Enter or
 * Space jumps. The current section carries `aria-current="location"` and the
 * selected treatment from the page tree (`accent-strong`, full ink, weight
 * 500), so "you are here" looks the same wherever the reader meets it.
 */
export function OutlineList({
  rows,
  activeIndex,
  onJump,
  activeRef,
  className,
}: {
  rows: readonly OutlineRow[];
  activeIndex: number | null;
  onJump: (row: OutlineRow) => void;
  /** Receives the current row's button, to focus it or keep it in view. */
  activeRef?: React.Ref<HTMLButtonElement>;
  className?: string;
}) {
  const t = useTranslations('editor.pageOutline');
  const listRef = React.useRef<HTMLOListElement>(null);

  const onKeyDown = (event: React.KeyboardEvent<HTMLOListElement>): void => {
    const buttons = [...(listRef.current?.querySelectorAll('button') ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const target = (() => {
      switch (event.key) {
        case 'ArrowDown':
          return Math.min(current + 1, buttons.length - 1);
        case 'ArrowUp':
          return Math.max(current - 1, 0);
        case 'Home':
          return 0;
        case 'End':
          return buttons.length - 1;
        default:
          return null;
      }
    })();
    if (target === null) return;
    event.preventDefault();
    buttons[target]?.focus();
  };

  return (
    <ol ref={listRef} className={cn('flex flex-col gap-px', className)} onKeyDown={onKeyDown}>
      {rows.map((row) => {
        const active = row.index === activeIndex;
        const text = row.entry.text.length > 0 ? row.entry.text : t('untitled');
        return (
          <li key={row.entry.blockId ?? `index-${String(row.index)}`}>
            <button
              ref={active ? activeRef : undefined}
              type="button"
              title={text}
              aria-current={active ? 'location' : undefined}
              data-testid="page-outline-entry"
              data-depth={row.depth}
              onClick={() => onJump(row)}
              // Indentation carries the hierarchy; depth beyond three is still
              // indented, one step less each time, so a deep page keeps its text.
              style={{ paddingInlineStart: `${String(0.5 + indentOf(row.depth))}rem` }}
              className={cn(
                'flex w-full items-start gap-1.5 rounded-sm py-1 pr-2 text-left text-ui',
                'text-muted-foreground transition-colors hover:bg-accent-solid hover:text-foreground',
                row.depth === 0 && 'text-foreground',
                row.entry.text.length === 0 && 'italic',
                active && 'bg-accent-strong font-medium text-foreground hover:bg-accent-strong',
              )}
            >
              <span className="line-clamp-2 min-w-0 flex-1 break-words">{text}</span>
              {row.entry.collapsed ? (
                <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-muted-foreground">
                  <ChevronRight className="size-3.5" aria-hidden />
                  {row.hiddenCount > 0 ? (
                    <span className="exocortex-numeric text-micro" aria-hidden>
                      {row.hiddenCount}
                    </span>
                  ) : null}
                  <span className="sr-only">{t('collapsed', { count: row.hiddenCount })}</span>
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** 0, 0.75, 1.375, 1.875 …: each level indents less than the one before. */
function indentOf(depth: number): number {
  let indent = 0;
  for (let level = 0; level < depth; level += 1) indent += Math.max(0.75 - level * 0.125, 0.5);
  return indent;
}
