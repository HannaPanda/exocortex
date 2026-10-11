/**
 * The headers every route that hands out a stored file sends with it
 * (issue #177).
 *
 * A file is served from the application's own origin, so a file the browser
 * is willing to treat as a document -- an SVG opened directly, above all --
 * would run its script with the reader's cookies and the whole API within
 * reach. `sandbox` in the policy is what stops that: without `allow-scripts`
 * no script runs, and without `allow-same-origin` the document is given an
 * opaque origin, so even a script that found a way to run would reach
 * nothing. `default-src 'none'` keeps the document from loading anything
 * either; the inline styles an SVG carries stay allowed, because they are
 * how it draws. An `<img>`, `<video>` or `<audio>` never applies a
 * response's policy to what it renders, so embedding is unaffected.
 *
 * PDF is the one exception: Chromium refuses to open a PDF in its own viewer
 * when the response is sandboxed, and a PDF's script runs inside the viewer,
 * never with the origin's cookies. It still gets `nosniff` and the
 * disposition, like everything else.
 */
export type FileDisposition = 'inline' | 'attachment';

export const FILE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

const UNSANDBOXED_MIME_TYPES: ReadonlySet<string> = new Set(['application/pdf']);

export function fileResponseHeaders(file: {
  mimeType: string;
  byteSize: number;
  filename: string;
  disposition: FileDisposition;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': file.mimeType,
    'content-length': String(file.byteSize),
    // The filename is stripped of everything outside printable ASCII, and of
    // the quote and backslash that would end or escape the quoted string.
    'content-disposition': `${file.disposition}; filename="${file.filename.replace(/[^\x20-\x7e]|["\\]/g, '_')}"`,
    'x-content-type-options': 'nosniff',
  };
  if (!UNSANDBOXED_MIME_TYPES.has(file.mimeType)) {
    headers['content-security-policy'] = FILE_CONTENT_SECURITY_POLICY;
  }
  return headers;
}
