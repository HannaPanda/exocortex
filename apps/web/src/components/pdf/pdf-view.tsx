'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { type PDFDocumentProxy } from 'pdfjs-dist';
import * as React from 'react';

import { type ProjectSourceArea } from '@exocortex/contracts';
import { Button, cn, ErrorState, LoadingState } from '@exocortex/ui';

import { type PdfPageSize, usePdfDocument, usePdfPageSizes } from './pdf-document';

/**
 * A PDF, drawn by us (issue #53, then #70).
 *
 * Written for a LaTeX project's result pane, where the whole reason to draw the
 * pages ourselves is the click: a browser's own viewer will not say where it
 * was clicked -- not the page, not the coordinates -- and without that the
 * SyncTeX map beside the file answers a question nobody can ask.
 *
 * It is the only PDF viewer in the application since #70, because the other way
 * of showing one turned out not to work at all: an `<object>` is refused by our
 * own `object-src 'none'`, silently, falling back to the download link inside
 * it. So the PDF block in the page editor mounts this too, without the click.
 *
 * It is deliberately not a PDF reader. No text selection, no search, no
 * thumbnails, no annotations -- pages, zoom, and a click that knows its place.
 *
 * It does follow its box, though (issue #241): the default zoom is the pane's
 * width, measured for as long as the pane exists, so a PDF block on a page
 * whose width was changed, or a project pane being dragged, is drawn again for
 * the room it has instead of keeping the size it opened with.
 */

/** Zoom steps, and the one the buttons move between. */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

/** Pages drawn ahead of and behind the viewport, so scrolling is not a blank. */
const RENDER_MARGIN_PX = 1200;

/**
 * How long a page that already has a bitmap waits before drawing it again at a
 * new scale. Dragging a panel edge changes the width every frame; the old
 * bitmap is stretched to the new box meanwhile, which is blurry for a moment
 * rather than wrong, and only the width the drag ends on is drawn.
 */
const REDRAW_DELAY_MS = 150;

/** The padding around the column of pages, on each side (`p-3`). */
const COLUMN_PADDING_PX = 12;

/**
 * Where the reader is: a page, and how far down it, as a share of its height.
 *
 * A share rather than pixels because a new scale changes every pixel offset
 * while the reader is still looking at the same line of the same page; the
 * horizontal centre is kept the same way for a zoom wider than the pane.
 */
interface ScrollAnchor {
  page: number;
  down: number;
  across: number;
}

interface PdfViewProps {
  url: string;
  /** Areas to mark, in PDF points from the top left of their page. */
  highlights?: readonly ProjectSourceArea[];
  /**
   * A click on a page, in PDF points from its top left corner.
   *
   * Absent where a click means nothing -- a PDF attached to a page has no
   * source to jump to -- and then the pages are not clickable at all rather
   * than clickable and inert.
   */
  onPickSource?: (position: { page: number; x: number; y: number }) => void;
}

export function PdfView({ url, highlights = [], onPickSource }: PdfViewProps) {
  const t = useTranslations('document.pdf');
  const { document, pageCount, error } = usePdfDocument(url);
  const sizes = usePdfPageSizes(document);

  // Kept in state as well as in a ref, so that measuring starts when the
  // scroll pane exists. It does not exist on the first renders: while the
  // pages are being measured the viewer shows its loading state instead. An
  // effect keyed on the document ran in exactly that window, found nothing to
  // observe, and never ran again, so every PDF was drawn at its own size in a
  // box that followed the page width around it (issue #241).
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [scroller, setScroller] = React.useState<HTMLDivElement | null>(null);
  const attachScroller = React.useCallback((element: HTMLDivElement | null) => {
    scrollRef.current = element;
    setScroller(element);
  }, []);
  const pageRefs = React.useRef(new Map<number, HTMLDivElement>());
  const anchorRef = React.useRef<ScrollAnchor | null>(null);
  const [available, setAvailable] = React.useState(0);
  /** Null means "as wide as the pane". A number is a zoom the reader chose. */
  const [zoom, setZoom] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (scroller === null) return;
    // Called once on `observe` as well, so the first width needs no read of
    // its own. Every later change of the room arrives here: the page width,
    // a side panel opening, the window, a project pane being dragged.
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setAvailable(entry.contentRect.width);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scroller]);

  const widest = sizes.reduce((max, size) => Math.max(max, size.width), 0);
  // Fitting to the full width would put the page edge under the padding; the
  // scrollbar has a gutter of its own (`scrollbar-gutter: stable`), so a page
  // that grows tall enough to need one does not narrow the room it was fitted
  // to and start over.
  const fitScale =
    widest > 0 && available > 0 ? Math.max(available - 2 * COLUMN_PADDING_PX, 1) / widest : 1;
  const scale = zoom ?? fitScale;
  // No page is laid out before the room is known: one drawn at the file's own
  // size first would be a wasted render and a visible jump.
  const measured = available > 0 && sizes.length > 0;

  // A new scale keeps the reader where they were. Before the paint, so the
  // pages never show at the new size with the old scroll offset.
  React.useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const container = scrollRef.current;
    if (container === null || anchor === null) return;
    const page = pageRefs.current.get(anchor.page);
    if (page === undefined) return;
    container.scrollTop = page.offsetTop + anchor.down * page.offsetHeight;
    container.scrollLeft = anchor.across * container.scrollWidth - container.clientWidth / 2;
  }, [scale]);

  const onScroll = React.useCallback(() => {
    const container = scrollRef.current;
    if (container === null) return;
    anchorRef.current = readAnchor(container, pageRefs.current);
  }, []);

  // The scale at the moment the mark arrives, read through a ref so that a
  // resize does not pull the pane back to the mark the reader scrolled away
  // from; the anchor above keeps the place instead.
  const scaleRef = React.useRef(scale);
  React.useLayoutEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  const first = highlights[0] ?? null;
  React.useEffect(() => {
    if (first === null || !measured) return;
    const page = pageRefs.current.get(first.page);
    const container = scrollRef.current;
    if (page === undefined || container === null) return;
    // Two thirds of a pane above the mark rather than centred: the answer to
    // "where is my cursor" is usually read downwards from there.
    const target = page.offsetTop + first.top * scaleRef.current - container.clientHeight / 3;
    container.scrollTo({ top: Math.max(target, 0), behavior: 'smooth' });
  }, [first, measured]);

  if (error !== null) {
    return (
      <ErrorState
        title={t('unreadableTitle')}
        description={
          error.detail === null
            ? t('unreadable')
            : t('unreadableWithReason', { reason: error.detail })
        }
      />
    );
  }
  if (document === null || sizes.length === 0) {
    return <LoadingState label={t('loading')} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ZoomBar
        pageCount={pageCount}
        zoom={zoom}
        fitScale={fitScale}
        clickable={onPickSource !== undefined}
        onZoom={setZoom}
        onFit={() => setZoom(null)}
      />
      {/* Positioned, so that a page's `offsetTop` is measured from here. */}
      <div
        ref={attachScroller}
        onScroll={onScroll}
        data-testid="pdf-scroll"
        className="relative min-h-0 flex-1 overflow-auto bg-muted/40 [scrollbar-gutter:stable]"
      >
        <div className="flex w-max min-w-full flex-col items-center gap-3 p-3">
          {(measured ? sizes : []).map((size, index) => (
            <PdfPage
              key={index}
              document={document}
              pageNumber={index + 1}
              size={size}
              scale={scale}
              marks={highlights.filter((area) => area.page === index + 1)}
              onPick={
                onPickSource === undefined
                  ? null
                  : (x, y) => onPickSource({ page: index + 1, x, y })
              }
              register={(element) => {
                if (element === null) pageRefs.current.delete(index + 1);
                else pageRefs.current.set(index + 1, element);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The page at the top edge of the pane and how far down it the edge is.
 *
 * Null at the very top: a reader who has not scrolled stays at the top, and a
 * share of the padding above the first page would be a few pixels of drift.
 */
function readAnchor(
  scroller: HTMLElement,
  pages: ReadonlyMap<number, HTMLElement>,
): ScrollAnchor | null {
  const top = scroller.scrollTop;
  const across =
    scroller.scrollWidth > 0
      ? (scroller.scrollLeft + scroller.clientWidth / 2) / scroller.scrollWidth
      : 0.5;
  if (top <= 0 && scroller.scrollLeft <= 0) return null;
  let found: ScrollAnchor | null = null;
  for (const [number, page] of pages) {
    if (page.offsetHeight <= 0) continue;
    // The gap below a page belongs to it, so the edge always lands somewhere.
    if (page.offsetTop <= top && (found === null || number > found.page)) {
      found = { page: number, down: (top - page.offsetTop) / page.offsetHeight, across };
    }
  }
  return found ?? { page: 1, down: 0, across };
}

function ZoomBar({
  pageCount,
  zoom,
  fitScale,
  clickable,
  onZoom,
  onFit,
}: {
  pageCount: number;
  zoom: number | null;
  fitScale: number;
  clickable: boolean;
  onZoom: (zoom: number) => void;
  onFit: () => void;
}) {
  const t = useTranslations('document.pdf');
  const format = useFormatter();
  const current = zoom ?? fitScale;
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1">
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('zoomOut')}
        disabled={current <= MIN_ZOOM}
        onClick={() => onZoom(Math.max(current - ZOOM_STEP, MIN_ZOOM))}
      >
        −
      </Button>
      <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
        {format.number(current, { style: 'percent', maximumFractionDigits: 0 })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('zoomIn')}
        disabled={current >= MAX_ZOOM}
        onClick={() => onZoom(Math.min(current + ZOOM_STEP, MAX_ZOOM))}
      >
        +
      </Button>
      <Button variant="ghost" size="sm" onClick={onFit} disabled={zoom === null}>
        {t('fitWidth')}
      </Button>
      <span className="ms-auto text-xs text-muted-foreground">
        {t('pageCount', { count: pageCount })}
        {clickable ? ` · ${t('clickHint')}` : ''}
      </span>
    </div>
  );
}

/**
 * One page: a canvas that draws when it comes near the viewport.
 *
 * The slot keeps its full height whether or not it has been drawn, which is
 * what lets the scroll position mean something before the last page has been
 * touched. Leaving the viewport clears the canvas again: a two hundred page
 * thesis at 200 percent would otherwise hold two hundred bitmaps at once.
 */
function PdfPage({
  document,
  pageNumber,
  size,
  scale,
  marks,
  onPick,
  register,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  size: PdfPageSize;
  scale: number;
  marks: readonly ProjectSourceArea[];
  onPick: ((x: number, y: number) => void) | null;
  register: (element: HTMLDivElement | null) => void;
}) {
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [near, setNear] = React.useState(false);

  React.useEffect(() => {
    const element = wrapperRef.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry?.isIntersecting ?? false),
      { rootMargin: `${String(RENDER_MARGIN_PX)}px 0px` },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    if (!near) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }

    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    // Drawn at the device's own resolution: a canvas scaled up by the browser
    // turns 9pt footnotes into grey mush, which is exactly the text somebody
    // zooms in to read.
    const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const draw = () => {
      void document.getPage(pageNumber).then((page) => {
        if (cancelled) return;
        const viewport = page.getViewport({ scale: scale * ratio });
        // Sized only now, together with the render: clearing the old bitmap
        // any earlier would blank the page for the whole delay below.
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const render = page.render({ canvas, viewport });
        task = render;
        render.promise.catch(() => {
          // A cancelled render rejects, and a cancelled render is the ordinary
          // case here: every zoom step replaces the one before it.
        });
      });
    };
    // A first drawing is immediate; a redrawing waits for the width to settle.
    const timer = canvas.width > 0 ? window.setTimeout(draw, REDRAW_DELAY_MS) : null;
    if (timer === null) draw();

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      task?.cancel();
    };
  }, [document, pageNumber, scale, near]);

  const width = size.width * scale;
  const height = size.height * scale;

  return (
    <div
      ref={(element) => {
        wrapperRef.current = element;
        register(element);
      }}
      className={cn(
        'relative bg-background shadow-sm ring-1 ring-border',
        onPick !== null && 'cursor-crosshair',
      )}
      style={{ width, height }}
      data-testid="pdf-page"
      data-page={pageNumber}
      onClick={
        onPick === null
          ? undefined
          : (event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onPick((event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale);
            }
      }
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      {marks.map((area, index) => (
        <span
          key={index}
          aria-hidden
          data-testid="pdf-mark"
          className={cn(
            'pointer-events-none absolute rounded-xs bg-primary/25 ring-1 ring-primary/50',
          )}
          style={{
            left: area.left * scale,
            top: area.top * scale,
            width: Math.max(area.width * scale, 2),
            // A line that only left a baseline behind gets a marker tall enough
            // to see; zero would be an answer nobody can find.
            height: Math.max(area.height * scale, 10),
          }}
        />
      ))}
    </div>
  );
}
