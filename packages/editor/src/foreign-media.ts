import { type ProseMirrorDocument, type ProseMirrorNode } from './contract';

/**
 * Media a page points at that the browser will refuse to load (issue #117).
 *
 * The Content Security Policy in `apps/web/next.config.ts` says
 * `img-src 'self' blob: data:` and `media-src 'self' blob:`, because everything
 * this application shows comes from `/api/attachments/:id/download`. A picture
 * on somebody else's host is therefore not a picture that loads slowly or
 * sometimes: it is a picture that never appears, with nothing in the page, the
 * editor or the write response saying why.
 *
 * That silence is what this is for. It does not rewrite anything -- where a
 * file should live is the writer's decision, and an address that is wrong today
 * may be an upload away from being right -- it only makes the write say so.
 */

/**
 * Node types whose `src` the policy restricts to this origin.
 *
 * `fileAttachment` is deliberately absent: it renders a link, and a link to
 * another host is a link, not a blocked resource. `embed` is absent for the
 * opposite reason: `frame-src 'none'` refuses it wherever it points, so a
 * warning about its address would name the wrong cause.
 */
export const SAME_ORIGIN_MEDIA_TYPES: readonly string[] = ['image', 'video', 'audio', 'pdf'];

export interface ForeignMediaSource {
  /** ProseMirror node type, so a caller can say "Bild" rather than "Medium". */
  type: string;
  src: string;
}

/**
 * Whether an address points somewhere the policy will not load from.
 *
 * A relative path is same-origin by construction and `data:`/`blob:` are
 * allowed outright, so only an absolute `http(s)` address can be foreign -- and
 * one that names this deployment's own origin is not. `origin` is optional
 * because the editor has no configuration: the API knows `APP_URL` and passes
 * it, and without it an absolute address to our own host is reported too, which
 * is a warning nobody has to act on rather than a missing one somebody does.
 */
export function isForeignMediaSource(src: string, origin?: string): boolean {
  if (!/^https?:\/\//i.test(src)) return false;
  if (origin === undefined) return true;
  try {
    return new URL(src).origin !== new URL(origin).origin;
  } catch {
    return true;
  }
}

/** Every restricted media node of `document` whose `src` is foreign, in reading order. */
export function collectForeignMediaSources(
  document: ProseMirrorDocument,
  origin?: string,
): ForeignMediaSource[] {
  const found: ForeignMediaSource[] = [];

  const walk = (node: ProseMirrorNode): void => {
    if (SAME_ORIGIN_MEDIA_TYPES.includes(node.type)) {
      const src = node.attrs?.src;
      if (typeof src === 'string' && isForeignMediaSource(src, origin)) {
        found.push({ type: node.type, src });
      }
    }
    for (const child of node.content ?? []) walk(child);
  };

  for (const child of document.content ?? []) walk(child);
  return found;
}
