'use client';

import { type Editor } from '@tiptap/react';
import { Heading, Heading1, Heading2, Heading3, TableOfContents } from 'lucide-react';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { createPortal } from 'react-dom';

import { type OutlineTransparency } from '@exocortex/contracts';
import { cn, Popover, PopoverContent, PopoverTrigger } from '@exocortex/ui';

import { useLatest, usePaletteContribution } from '@/components/palette/contributions';
import { keywordsOf, type PaletteCommand } from '@/components/palette/palette-command';
import { useOutlinePreferences } from '@/lib/api/preferences-queries';

import {
  activeTickIndex,
  OUTLINE_GAP,
  overlayCovers,
  PINNED_LANE,
  railTicks,
} from './outline-geometry';
import {
  OutlineHeader,
  OutlineList,
  OutlinePinnedFrame,
  OutlinePinNote,
  OutlineRail,
  type OutlineRow,
  outlineRows,
} from './outline-view';
import { useOutlineDodge } from './use-outline-dodge';
import { type OutlineTracking, useOutlineTracking } from './use-outline-tracking';

/** A per-viewer convenience, so it lives in the browser and nowhere else. */
const PIN_STORAGE_KEY = 'exocortex.outline.pinned';

function readPinned(): boolean {
  try {
    return window.localStorage.getItem(PIN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writePinned(pinned: boolean): void {
  try {
    if (pinned) window.localStorage.setItem(PIN_STORAGE_KEY, 'true');
    else window.localStorage.removeItem(PIN_STORAGE_KEY);
  } catch {
    // A private window without storage simply forgets the choice.
  }
}

/**
 * The floating outline of a long page (issue #194).
 *
 * Drawn into the document area beside the scroll container (`data-outline-host`
 * in `document-view.tsx`), never into the editor: it is chrome, and nothing
 * the reader does with it writes to the document. Three shapes, chosen by the
 * room right of the text column (`outlinePlacement`): the list pinned beside
 * the page, the collapsed scale in the margin, or on a phone a compact button
 * floating at the bottom edge. A page without headings gets none of them.
 * The list and the scale start below the page head (cover, its menu, title)
 * and rise with it to the top edge while the reader scrolls (issue #266).
 * Pinned, the list takes a column of the page area for itself, whatever the
 * page width, and the page is laid out in what is left (issue #267), unless
 * the reader chose to have it lie over the text instead (`outlinePinned:
 * 'overlay'`, issue #283): then the text stays where it is, and the list only
 * covers it where the margin is too narrow to hold it.
 */
export const PageOutline = React.memo(function PageOutline({ editor }: { editor: Editor }) {
  const t = useTranslations('editor.pageOutline');
  // Read once on mount; the editor only exists in the browser, so there is no
  // server render this could disagree with.
  const [pinRequested, setPinRequested] = React.useState(readPinned);
  const tracking = useOutlineTracking(editor, pinRequested);
  const { entries, activeIndex, wanted, placement, canPin, host, scrollbarWidth, jump } = tracking;
  const [open, setOpen] = React.useState(false);
  const activeRowRef = React.useRef<HTMLButtonElement>(null);
  const pinnedListRef = React.useRef<HTMLDivElement>(null);
  const pinnedFrameRef = React.useRef<HTMLElement>(null);
  const pinnedMode = usePinnedMode(editor, tracking, pinnedFrameRef, pinnedListRef);

  const rows = React.useMemo(() => outlineRows(entries), [entries]);
  const ticks = React.useMemo(() => railTicks(entries), [entries]);
  const activeTick = activeTickIndex(ticks, activeIndex);
  const activeRow = rows.find((row) => row.index === activeIndex) ?? null;

  useOutlineCommands(rows, jump);

  const setPinned = (pinned: boolean): void => {
    writePinned(pinned);
    setPinRequested(pinned);
    setOpen(false);
  };

  // Pinned, the current section is kept in view inside the list, by moving the
  // list's own scroll position: `scrollIntoView` would scroll the page too.
  React.useEffect(() => {
    if (placement !== 'pinned') return;
    const list = pinnedListRef.current;
    const row = activeRowRef.current;
    if (list === null || row === null) return;
    const rowTop = row.offsetTop - list.offsetTop;
    if (rowTop < list.scrollTop) list.scrollTop = rowTop - 8;
    else if (rowTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = rowTop + row.offsetHeight - list.clientHeight + 8;
    }
  }, [activeIndex, placement]);

  // A compact button floating over the text would sit on the line being typed
  // on a phone, so it steps aside while the editor has focus.
  const editing = useEditorFocused(editor) && editor.isEditable;

  if (host === null || !wanted) return null;

  const onJump = (row: OutlineRow): void => {
    jump(row.entry, row.index);
    if (placement !== 'pinned') setOpen(false);
  };
  const edge = { right: `${String(scrollbarWidth + OUTLINE_GAP / 2)}px` };
  const header = (
    <OutlineHeader pinned={placement === 'pinned'} canPin={canPin} onPinnedChange={setPinned} />
  );
  // Where the window is too narrow to give the list a column, the popover
  // says so instead of leaving the reader to look for a missing pin.
  const pinNote = canPin ? null : <OutlinePinNote />;
  const triggerLabel =
    activeRow === null
      ? t('open')
      : t('openAt', {
          section: activeRow.entry.text.length > 0 ? activeRow.entry.text : t('untitled'),
        });

  if (placement === 'pinned') {
    return createPortal(
      <OutlinePinnedFrame
        ref={pinnedFrameRef}
        aria-label={t('label')}
        data-testid="page-outline-pinned"
        data-mode={pinnedMode.overlay ? 'overlay' : 'column'}
        // Over the text only where the margin cannot hold the list; in a
        // margin wide enough it lies on nothing and stays flat (issue #283).
        covering={pinnedMode.covering}
        transparency={pinnedMode.transparency}
        style={edge}
        // `--outline-top` follows the page head (issue #266, `placeTop` in
        // `use-outline-tracking.ts`); the list ends 1.5rem above the bottom.
        // Laid over the text, it may step aside for the line being written
        // on (`use-outline-dodge.ts`, issue #283), which wins while it lasts.
        className="pointer-events-auto absolute top-[var(--outline-dodge-top,var(--outline-top,1.5rem))] max-h-[var(--outline-dodge-max,calc(100%-var(--outline-top,1.5rem)-1.5rem))]"
      >
        {header}
        <div ref={pinnedListRef} className="min-h-0 overflow-y-auto">
          <OutlineList
            rows={rows}
            activeIndex={activeIndex}
            onJump={onJump}
            activeRef={activeRowRef}
          />
        </div>
      </OutlinePinnedFrame>,
      host,
    );
  }

  const compact = placement === 'compact';
  if (compact && editing && !open) return null;

  return createPortal(
    <div
      style={edge}
      className={cn(
        'pointer-events-none absolute',
        compact ? 'bottom-4' : 'top-[var(--outline-top,1.5rem)]',
      )}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label={triggerLabel}
          title={triggerLabel}
          render={
            compact ? (
              <button
                type="button"
                data-testid="page-outline-compact"
                className={cn(
                  'pointer-events-auto flex size-11 items-center justify-center rounded-lg',
                  'border border-border-strong bg-popover text-foreground shadow-md',
                  'transition-colors hover:bg-accent-solid',
                )}
              >
                <TableOfContents className="size-5" aria-hidden />
              </button>
            ) : (
              <OutlineRail ticks={ticks} activeTick={activeTick} />
            )
          }
        />
        <PopoverContent
          side={compact ? 'top' : 'left'}
          align={compact ? 'end' : 'start'}
          sideOffset={8}
          initialFocus={activeRowRef}
          data-testid="page-outline-popover"
          className="flex max-h-[min(36rem,70vh)] w-72 max-w-[calc(100vw-2rem)] flex-col gap-1 p-1.5"
        >
          <nav aria-label={t('label')} className="flex min-h-0 flex-col gap-1">
            {header}
            <div className="min-h-0 overflow-y-auto">
              <OutlineList
                rows={rows}
                activeIndex={activeIndex}
                onJump={onJump}
                activeRef={activeRowRef}
              />
            </div>
            {pinNote}
          </nav>
        </PopoverContent>
      </Popover>
    </div>,
    host,
  );
});

/**
 * How the pinned list sits, from the reader's preferences (issue #283): in
 * its own column (the lane, issue #267), or over the text, where it is
 * `covering` when the margin cannot hold it and then steps aside for the
 * line being written on if the reader left that on.
 */
function usePinnedMode(
  editor: Editor,
  tracking: OutlineTracking,
  frame: React.RefObject<HTMLElement | null>,
  list: React.RefObject<HTMLElement | null>,
): { overlay: boolean; covering: boolean; transparency: OutlineTransparency } {
  const preferences = useOutlinePreferences();
  const pinned = tracking.wanted && tracking.placement === 'pinned';
  const overlay = preferences.pinned === 'overlay';
  const covering = overlay && overlayCovers(tracking.free);
  useOutlineLane(tracking.host, pinned && !overlay);
  useOutlineDodge({
    editor,
    host: tracking.host,
    frame,
    list,
    enabled: pinned && covering && preferences.dodge,
  });
  return { overlay, covering, transparency: preferences.transparency };
}

/**
 * Takes the pinned list's column off the page area (issue #267): the host
 * carries `--outline-lane`, and globals.css turns it into the scroll
 * container's right padding, so the page centres in what is left and nothing
 * of it, a database breaking out of the measure included, runs under the
 * list. A layout effect, so the text never shows for a frame under the list.
 */
function useOutlineLane(host: HTMLElement | null, pinned: boolean): void {
  React.useLayoutEffect(() => {
    if (host === null || !pinned) return;
    host.style.setProperty('--outline-lane', `${String(PINNED_LANE)}px`);
    return () => {
      host.style.removeProperty('--outline-lane');
    };
  }, [host, pinned]);
}

function useEditorFocused(editor: Editor): boolean {
  const [focused, setFocused] = React.useState(() => editor.isFocused);
  React.useEffect(() => {
    const onFocus = (): void => setFocused(true);
    const onBlur = (): void => setFocused(false);
    editor.on('focus', onFocus);
    editor.on('blur', onBlur);
    return () => {
      editor.off('focus', onFocus);
      editor.off('blur', onBlur);
    };
  }, [editor]);
  return focused;
}

const LEVEL_ICONS = [Heading1, Heading2, Heading3] as const;

/**
 * "Zu Abschnitt springen → …" in the palette, for a reader who would rather
 * type a heading than look for it (CLAUDE.md rule 16). Same rows, same jump:
 * a collapsed section is a choice, and what it hides is not offered.
 */
function useOutlineCommands(
  rows: readonly OutlineRow[],
  jump: (entry: OutlineRow['entry'], index: number) => void,
): void {
  const t = useTranslations('shell.paletteCommands.page');
  const tOutline = useTranslations('editor.pageOutline');
  const jumpRef = useLatest(jump);
  const commands = React.useMemo<readonly PaletteCommand[]>(() => {
    if (rows.length < 2) return [];
    const choices: PaletteCommand[] = rows.map((row) => {
      const Icon = LEVEL_ICONS[row.entry.level - 1] ?? Heading;
      return {
        id: `page-outline-${row.entry.blockId ?? String(row.index)}`,
        group: 'page',
        label: row.entry.text.length > 0 ? row.entry.text : tOutline('untitled'),
        hint: t('headingLevel', { level: row.entry.level }),
        icon: <Icon className="size-4 text-muted-foreground" />,
        keywords: [],
        run: () => jumpRef.current(row.entry, row.index),
      };
    });
    return [
      {
        id: 'page-outline',
        group: 'page',
        label: t('jumpToSection'),
        placeholder: t('jumpToSectionPlaceholder'),
        icon: <TableOfContents className="size-4 text-muted-foreground" />,
        keywords: keywordsOf(t('jumpToSectionKeywords')),
        children: () => choices,
      },
    ];
  }, [rows, t, tOutline, jumpRef]);
  usePaletteContribution('page-outline', commands);
}
