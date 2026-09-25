'use client';

import * as React from 'react';
import { createRoot } from 'react-dom/client';

import {
  attachmentTextEngine,
  type AttachmentTextInfoResponse,
  type AttachmentTextResponse,
} from '@exocortex/contracts';
import {
  type MediaDocumentDetail,
  type MediaDocumentInfo,
  type MediaInfoResolver,
} from '@exocortex/editor';

import { PdfBlockRoot, type ReaderIntl } from '@/components/pdf/pdf-block-root';

import { apiRequest } from './client';

/**
 * The `src` a media block carries always points at the download route (see
 * `uploadAttachment`), which is the only place the attachment id survives in
 * the document. Anything else -- a pasted external URL, an old-style link --
 * simply has nothing to describe.
 */
const ATTACHMENT_DOWNLOAD_SRC = /^\/api\/attachments\/([^/]+)\/download$/;

function attachmentIdFrom(src: string): string | null {
  return ATTACHMENT_DOWNLOAD_SRC.exec(src)?.[1] ?? null;
}

/** Keeps only what the block renders; the text, if any, is not carried around. */
function toInfo(response: AttachmentTextInfoResponse | AttachmentTextResponse): MediaDocumentInfo {
  return {
    status: response.status,
    metadata: response.metadata,
    error: response.error,
    errorCode: response.errorCode,
    filename: response.filename,
    // What separates "an image has no text" from "nobody has read this
    // document yet", which the API reports with the same status. The same
    // predicate the API decides with, so the bar is offered exactly where it
    // can be filled.
    extractable: attachmentTextEngine(response.mimeType) !== null,
    correction: response.correction,
    truncated: response.truncated,
  };
}

/** The heavier answer, kept only for the "Ansehen" dialog (issue #2). */
function toDetail(response: AttachmentTextResponse): MediaDocumentDetail {
  return { ...toInfo(response), text: response.text, machineText: response.machineText };
}

/**
 * Lets the editor's file and PDF blocks describe their own contents.
 *
 * `read` runs on every render and must not start anything, so it uses the
 * side-effect-free `/text/info`. `request` is the explicit "try again" and
 * uses `/text`, whose read *is* the request to extract -- getting that the
 * wrong way round would mean a page full of failed PDFs re-runs extraction
 * every time someone opens it. `readText`, `forceReextract` and `correctText`
 * are the three explicit acts issue #2 added on top: viewing the full text,
 * forcing a re-extraction of an already-`ready` attachment, and writing or
 * clearing a human correction.
 */
const attachmentMediaInfoResolver: MediaInfoResolver = {
  async read(src: string): Promise<MediaDocumentInfo | null> {
    const attachmentId = attachmentIdFrom(src);
    if (attachmentId === null) return null;
    const response = await apiRequest<AttachmentTextInfoResponse>(
      `/api/attachments/${attachmentId}/text/info`,
    );
    return toInfo(response);
  },

  async request(src: string): Promise<MediaDocumentInfo | null> {
    const attachmentId = attachmentIdFrom(src);
    if (attachmentId === null) return null;
    const response = await apiRequest<AttachmentTextResponse>(
      `/api/attachments/${attachmentId}/text`,
    );
    return toInfo(response);
  },

  async readText(src: string): Promise<MediaDocumentDetail | null> {
    const attachmentId = attachmentIdFrom(src);
    if (attachmentId === null) return null;
    const response = await apiRequest<AttachmentTextResponse>(
      `/api/attachments/${attachmentId}/text`,
    );
    return toDetail(response);
  },

  async forceReextract(src: string): Promise<MediaDocumentInfo | null> {
    const attachmentId = attachmentIdFrom(src);
    if (attachmentId === null) return null;
    const response = await apiRequest<AttachmentTextResponse>(
      `/api/attachments/${attachmentId}/text/reextract`,
      { method: 'POST' },
    );
    return toInfo(response);
  },

  async correctText(src: string, text: string | null): Promise<MediaDocumentDetail | null> {
    const attachmentId = attachmentIdFrom(src);
    if (attachmentId === null) return null;
    const response = await apiRequest<AttachmentTextResponse>(
      `/api/attachments/${attachmentId}/text`,
      { method: 'PATCH', body: { text } },
    );
    return toDetail(response);
  },
};

/**
 * The resolver for an editor read in `intl`: the one above plus `renderPdf`,
 * which needs the language handed in because its root sits outside every
 * provider of the page (`PdfBlockRoot`).
 */
export function attachmentMediaInfoResolverFor(intl: ReaderIntl): MediaInfoResolver {
  return {
    ...attachmentMediaInfoResolver,
    renderPdf: (container, src) => mountPdf(container, src, intl),
  };
}

/**
 * Draws the PDF into the block, with the same viewer a project's result pane
 * uses (issue #70).
 *
 * A React root of its own inside a Tiptap node view, which is the seam this
 * hook exists for: `packages/editor` builds plain DOM and is read by the
 * server too, so the renderer has to be mounted from here. `unmount` is
 * deferred to a microtask because the node view destroys it while React is
 * still committing the tree the editor is inside, and unmounting a root
 * during another root's render is what React warns about.
 */
function mountPdf(container: HTMLElement, src: string, intl: ReaderIntl): () => void {
  const root = createRoot(container);
  root.render(React.createElement(PdfBlockRoot, { url: src, intl }));
  return () => {
    queueMicrotask(() => root.unmount());
  };
}
