'use client';

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
 */

/** Zoom steps, and the one the buttons move between. */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

/** Pages drawn ahead of and behind the viewport, so scrolling is not a blank. */
const RENDER_MARGIN_PX = 1200;

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
  const { document, pageCount, error } = usePdfDocument(url);
  const sizes = usePdfPageSizes(document);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const pageRefs = React.useRef(new Map<number, HTMLDivElement>());
  const [available, setAvailable] = React.useState(0);
  /** Null means "as wide as the pane". A number is a zoom the reader chose. */
  const [zoom, setZoom] = React.useState<number | null>(null);

  React.useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setAvailable(entry.contentRect.width);
    });
    observer.observe(element);
    setAvailable(element.clientWidth);
    return () => observer.disconnect();
  }, [document]);

  const widest = sizes.reduce((max, size) => Math.max(max, size.width), 0);
  // 24px is the padding around the column; fitting to the full width would put
  // the page edge under the scrollbar.
  const fitScale = widest > 0 && available > 0 ? (available - 24) / widest : 1;
  const scale = zoom ?? fitScale;

  const first = highlights[0] ?? null;
  React.useEffect(() => {
    if (first === null) return;
    const page = pageRefs.current.get(first.page);
    const container = scrollRef.current;
    if (page === undefined || container === null) return;
    // Two thirds of a pane above the mark rather than centred: the answer to
    // "where is my cursor" is usually read downwards from there.
    const target = page.offsetTop + first.top * scale - container.clientHeight / 3;
    container.scrollTo({ top: Math.max(target, 0), behavior: 'smooth' });
  }, [first, scale]);

  if (error !== null) return <ErrorState title="PDF nicht lesbar" description={error} />;
  if (document === null || sizes.length === 0) {
    return <LoadingState label="PDF wird geladen …" />;
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-muted/40">
        <div className="flex flex-col items-center gap-3 p-3">
          {sizes.map((size, index) => (
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
  const current = zoom ?? fitScale;
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1">
      <Button
        variant="ghost"
        size="sm"
        aria-label="Verkleinern"
        disabled={current <= MIN_ZOOM}
        onClick={() => onZoom(Math.max(current - ZOOM_STEP, MIN_ZOOM))}
      >
        −
      </Button>
      <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
        {Math.round(current * 100)} %
      </span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Vergrößern"
        disabled={current >= MAX_ZOOM}
        onClick={() => onZoom(Math.min(current + ZOOM_STEP, MAX_ZOOM))}
      >
        +
      </Button>
      <Button variant="ghost" size="sm" onClick={onFit} disabled={zoom === null}>
        Breite
      </Button>
      <span className="ms-auto text-xs text-muted-foreground">
        {pageCount} {pageCount === 1 ? 'Seite' : 'Seiten'}
        {clickable ? ' · Klick springt in die Quelle' : ''}
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
    void document.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale: scale * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const render = page.render({ canvas, viewport });
      task = render;
      render.promise.catch(() => {
        // A cancelled render rejects, and a cancelled render is the ordinary
        // case here: every zoom step replaces the one before it.
      });
    });

    return () => {
      cancelled = true;
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
