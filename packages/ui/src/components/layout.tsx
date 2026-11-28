'use client';

import * as React from 'react';
import { useTranslations } from 'use-intl';

import { cn } from '../lib/utils';

/**
 * Layout primitives of the application shell.
 *
 * `ResizablePanel` is implemented locally instead of pulling in a panel library:
 * the requirement is a single draggable divider with keyboard support, which is
 * ~60 lines and keeps the dependency surface small (docs/ui-system.md). Its
 * divider is `ResizeHandle`, which a panel that is not a column of the shell
 * (the row panel over the page area, issue #239) uses on its own.
 */

export function AppShell({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={cn('flex h-dvh w-full flex-col overflow-hidden bg-background', className)}
      {...props}
    />
  );
}

export function AppHeader({ className, ...props }: React.ComponentPropsWithoutRef<'header'>) {
  return (
    <header
      className={cn(
        // The chrome sits one surface step above the canvas: the darkest plane in
        // the app is the one you write on (docs/ui-system.md, surface ladder).
        //
        // A minimum height and a wrap rather than a fixed height: at 200 % text
        // zoom every control in here doubles, and a bar that cannot grow pushes
        // its right-hand end past the window instead -- which is WCAG 1.4.4,
        // content lost to a resize nobody can scroll to. Nothing wraps at an
        // ordinary text size, because everything in the bar can shrink first.
        'flex min-h-[var(--header-height)] shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-1',
        className,
      )}
      {...props}
    />
  );
}

export function AppBody({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div className={cn('flex min-h-0 flex-1', className)} {...props} />;
}

export function AppMain({ className, ...props }: React.ComponentPropsWithoutRef<'main'>) {
  return (
    <main
      className={cn('flex min-w-0 flex-1 flex-col overflow-hidden', className)}
      id="exocortex-main"
      {...props}
    />
  );
}

export interface AppPageProps extends React.ComponentPropsWithoutRef<'div'> {
  /**
   * Tailwind max-width utility for the centered column, e.g. `'max-w-3xl'`.
   * Passed as a literal so the Tailwind scanner (`@source` in globals.css)
   * picks it up at the call site.
   */
  maxWidth: string;
}

/**
 * A non-editor page's own scroll container: centered, padded, and — this is
 * the part that is easy to forget — able to actually scroll.
 *
 * `AppShell`/`AppMain` clip on purpose (`overflow-hidden`) so the editor can
 * run several independent scroll regions without fighting over one scrollbar.
 * That means every other page must bring its own scroll area, and `min-h-0`
 * is required alongside `flex-1 overflow-y-auto`: without it a flex child
 * never shrinks below its content height, so the `overflow-y-auto` never
 * actually engages (see docs/ui-system.md and issue #15).
 *
 * `relative` is load-bearing too, and less obvious. A visually hidden element
 * (`sr-only`, a screen-reader-only label or table caption) is `position:
 * absolute`; with no positioned ancestor its containing block is the document
 * itself, so the browser places it at its static position measured from the
 * top of the *page*. Deep inside a long scroll area that lands thousands of
 * pixels below the viewport and stretches the document's scroll height, which
 * reads as the page scrolling far past its own content into nothing. Making
 * the scroll container the containing block keeps such elements inside it.
 */
export function AppPage({ maxWidth, className, ...props }: AppPageProps) {
  return (
    <div
      data-slot="app-page"
      className={cn(
        'relative mx-auto min-h-0 w-full flex-1 overflow-y-auto px-6 py-8',
        maxWidth,
        className,
      )}
      {...props}
    />
  );
}

export interface ResizablePanelProps extends React.ComponentPropsWithoutRef<'div'> {
  /** Current width in pixels. */
  width: number;
  onWidthChange: (width: number) => void;
  minWidth?: number;
  maxWidth?: number;
  /** Which edge carries the drag handle. */
  handle: 'right' | 'left';
  label: string;
}

export function ResizablePanel({
  width,
  onWidthChange,
  minWidth = 200,
  maxWidth = 560,
  handle,
  label,
  className,
  children,
  ...props
}: ResizablePanelProps) {
  return (
    <div
      className={cn('relative flex shrink-0 flex-col overflow-hidden', className)}
      style={{ width }}
      {...props}
    >
      {children}
      <ResizeHandle
        width={width}
        onWidthChange={onWidthChange}
        minWidth={minWidth}
        maxWidth={maxWidth}
        edge={handle}
        label={label}
        // Inset: the panel clips, and an outset ring would be cut off.
        className="focus-visible:ring-inset"
      />
    </div>
  );
}

export interface ResizeHandleProps {
  /** The panel's current width in pixels. */
  width: number;
  onWidthChange: (width: number) => void;
  minWidth: number;
  maxWidth: number;
  /** The panel edge the handle sits on; the opposite edge stays where it is. */
  edge: 'right' | 'left';
  label: string;
  /** Hover hint, for a handle whose double-click does something. */
  title?: string;
  /** Double-click: back to the panel's own default width. */
  onReset?: () => void;
  className?: string;
  'data-testid'?: string;
}

/**
 * The draggable divider of a panel, as a focusable `separator`: the pointer
 * (mouse, pen and touch alike) drags it, the arrow keys move it by 8 px (32
 * with Shift), Home and End go to the limits, and a double-click resets.
 *
 * It must be a direct child of the panel it sizes, which has to be
 * positioned: the width is measured from the panel's own rectangle, not the
 * window's edge, so a panel that does not start there (one lying over the
 * page area, issue #239) is sized the same way as one that does.
 */
export function ResizeHandle({
  width,
  onWidthChange,
  minWidth,
  maxWidth,
  edge,
  label,
  title,
  onReset,
  className,
  'data-testid': testId,
}: ResizeHandleProps) {
  // While a drag is under way: where the pointer would be if the panel had no
  // width at all. The fixed edge, shifted by where on the handle it was
  // grabbed, so the edge follows the pointer without jumping to it first.
  const anchor = React.useRef<number | null>(null);

  const clamp = React.useCallback(
    (value: number) => Math.round(Math.min(maxWidth, Math.max(minWidth, value))),
    [maxWidth, minWidth],
  );

  React.useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      if (anchor.current === null) return;
      const next =
        edge === 'right' ? event.clientX - anchor.current : anchor.current - event.clientX;
      onWidthChange(clamp(next));
    };
    const onPointerUp = (): void => {
      if (anchor.current === null) return;
      anchor.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [clamp, edge, onWidthChange]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={title}
      aria-valuenow={Math.round(width)}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      data-testid={testId ?? `resize-handle-${edge}`}
      className={cn(
        // `touch-none`: a finger on the handle drags it instead of scrolling.
        'absolute top-0 h-full w-1 cursor-col-resize touch-none transition-colors hover:bg-primary/50',
        edge === 'right' ? 'right-0' : 'left-0',
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const panel = event.currentTarget.parentElement;
        if (panel === null) return;
        event.preventDefault();
        const rect = panel.getBoundingClientRect();
        anchor.current = edge === 'right' ? event.clientX - rect.width : event.clientX + rect.width;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 32 : 8;
        const grow = (by: number): void => {
          event.preventDefault();
          onWidthChange(clamp(width + by));
        };
        if (event.key === 'ArrowLeft') grow(edge === 'right' ? -step : step);
        if (event.key === 'ArrowRight') grow(edge === 'right' ? step : -step);
        if (event.key === 'Home') {
          event.preventDefault();
          onWidthChange(minWidth);
        }
        if (event.key === 'End') {
          event.preventDefault();
          onWidthChange(maxWidth);
        }
      }}
    />
  );
}

/** Skip link so keyboard users can jump past the navigation. */
export function SkipToContentLink() {
  const t = useTranslations('ui.layout');
  return (
    <a
      href="#exocortex-main"
      className="exocortex-sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-100 focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-sm"
    >
      {t('skipToContent')}
    </a>
  );
}
