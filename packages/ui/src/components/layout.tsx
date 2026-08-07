'use client';

import * as React from 'react';

import { cn } from '../lib/utils';

/**
 * Layout primitives of the application shell.
 *
 * `ResizablePanel` is implemented locally instead of pulling in a panel library:
 * the requirement is a single draggable divider with keyboard support, which is
 * ~60 lines and keeps the dependency surface small (docs/ui-system.md).
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
        'flex h-[var(--header-height)] shrink-0 items-center gap-2 border-b border-border bg-surface px-3',
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
 */
export function AppPage({ maxWidth, className, ...props }: AppPageProps) {
  return (
    <div
      className={cn('mx-auto min-h-0 w-full flex-1 overflow-y-auto px-6 py-8', maxWidth, className)}
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
  const dragging = React.useRef(false);

  const clamp = React.useCallback(
    (value: number) => Math.min(maxWidth, Math.max(minWidth, value)),
    [maxWidth, minWidth],
  );

  React.useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging.current) return;
      const next = handle === 'right' ? event.clientX : window.innerWidth - event.clientX;
      onWidthChange(clamp(next));
    };
    const onPointerUp = (): void => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [clamp, handle, onWidthChange]);

  return (
    <div
      className={cn('relative flex shrink-0 flex-col overflow-hidden', className)}
      style={{ width }}
      {...props}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={width}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        tabIndex={0}
        data-testid={`resize-handle-${handle}`}
        className={cn(
          'absolute top-0 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/50 focus-visible:bg-primary',
          handle === 'right' ? 'right-0' : 'left-0',
        )}
        onPointerDown={(event) => {
          event.preventDefault();
          dragging.current = true;
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 32 : 8;
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            onWidthChange(clamp(width + (handle === 'right' ? -step : step)));
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            onWidthChange(clamp(width + (handle === 'right' ? step : -step)));
          }
        }}
      />
    </div>
  );
}

/** Skip link so keyboard users can jump past the navigation. */
export function SkipToContentLink() {
  return (
    <a
      href="#exocortex-main"
      className="exocortex-sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-100 focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-sm"
    >
      Zum Inhalt springen
    </a>
  );
}
