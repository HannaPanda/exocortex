'use client';

import {
  type AttachmentTextInfoResponse,
  type AttachmentTextResponse,
} from '@exocortex/contracts';
import { type MediaDocumentInfo, type MediaInfoResolver } from '@exocortex/editor';

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
    filename: response.filename,
  };
}

/**
 * Lets the editor's file and PDF blocks describe their own contents.
 *
 * Two routes, deliberately: `read` runs on every render and must not start
 * anything, so it uses the side-effect-free `/text/info`. `request` is the
 * explicit "try again" and uses `/text`, whose read *is* the request to
 * extract. Getting that the wrong way round would mean a page full of failed
 * PDFs re-runs extraction every time someone opens it.
 */
export const attachmentMediaInfoResolver: MediaInfoResolver = {
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
};
