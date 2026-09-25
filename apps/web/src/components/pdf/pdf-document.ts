'use client';

import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist';
import * as React from 'react';

/**
 * Loading a PDF into the browser, once (issue #53, ADR-027).
 *
 * pdf.js rather than the browser's own viewer, and the reason is the only thing
 * that made this worth doing: an `<object>` renders a PDF beautifully and tells
 * the page around it nothing at all -- not which page is shown, not where a
 * click landed. A click that knows its own place is what SyncTeX needs, and it
 * only exists once we draw the pages ourselves.
 *
 * Two things about this file are about the deployment rather than about PDFs.
 * The worker is referenced through `new URL(..., import.meta.url)`, which is the
 * form both bundlers resolve into a same-origin asset -- a worker loaded from a
 * CDN would be refused by the `worker-src 'self' blob:` line of our own CSP, and
 * rightly. And the fetch carries credentials, because the file is an ordinary
 * attachment behind the session cookie, like every other file this app shows.
 */

if (typeof window !== 'undefined' && GlobalWorkerOptions.workerSrc === '') {
  GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
}

export interface PdfDocumentState {
  document: PDFDocumentProxy | null;
  pageCount: number;
  /**
   * Why the file did not open, or null while nothing went wrong. `detail` is
   * pdf.js's own message, when it gave one; the sentence around it is the
   * viewer's, in the reader's language.
   */
  error: { detail: string | null } | null;
}

const EMPTY: PdfDocumentState = { document: null, pageCount: 0, error: null };

/**
 * The open document, or nothing while a different file is being opened.
 *
 * The loaded state carries the url it belongs to rather than being cleared when
 * the url changes. Same effect, one fewer render, and no window in which the
 * previous build's pages are on screen under the new build's page count.
 */
export function usePdfDocument(url: string | null): PdfDocumentState {
  const [loaded, setLoaded] = React.useState<(PdfDocumentState & { url: string }) | null>(null);

  React.useEffect(() => {
    if (url === null) return;

    let cancelled = false;
    const task = getDocument({ url, withCredentials: true });
    void task.promise.then(
      (document) => {
        // The unmount already ran and took the loading task with it, which is
        // what closes the worker; there is nothing left to hand to a component
        // that is gone.
        if (cancelled) return;
        setLoaded({ url, document, pageCount: document.numPages, error: null });
      },
      (error: unknown) => {
        if (cancelled) return;
        setLoaded({
          url,
          document: null,
          pageCount: 0,
          error: {
            detail: error instanceof Error && error.message.length > 0 ? error.message : null,
          },
        });
      },
    );

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url]);

  return loaded !== null && loaded.url === url ? loaded : EMPTY;
}

/** The unscaled size of one page, in PDF points. */
export interface PdfPageSize {
  width: number;
  height: number;
}

/**
 * Every page's size, read once when the document opens.
 *
 * Up front rather than per page, because the scroll container has to be its
 * full height before anything is drawn: a viewer that grows as pages render
 * moves the page out from under the reader's cursor, and a click that lands
 * somewhere else than it was aimed is worse here than in most places.
 */
export function usePdfPageSizes(document: PDFDocumentProxy | null): readonly PdfPageSize[] {
  const [measured, setMeasured] = React.useState<{
    document: PDFDocumentProxy;
    sizes: readonly PdfPageSize[];
  } | null>(null);

  React.useEffect(() => {
    if (document === null) return;
    let cancelled = false;
    const numbers = Array.from({ length: document.numPages }, (_, index) => index + 1);
    void Promise.all(numbers.map((number) => document.getPage(number))).then(
      (pages: PDFPageProxy[]) => {
        if (cancelled) return;
        setMeasured({
          document,
          sizes: pages.map((page) => {
            const viewport = page.getViewport({ scale: 1 });
            return { width: viewport.width, height: viewport.height };
          }),
        });
      },
      () => {
        // A document that opened but cannot describe its pages is broken past
        // what this hook can say about it; the viewer shows its own error.
        if (!cancelled) setMeasured({ document, sizes: [] });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [document]);

  return measured !== null && measured.document === document ? measured.sizes : [];
}
