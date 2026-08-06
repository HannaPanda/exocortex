import { z } from 'zod';

import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * The internal contract between the REST API and the collaboration server
 * (ADR-016).
 *
 * Everything here describes a single, private endpoint that is never reachable
 * from a browser: `POST /internal/documents/:documentId/content` on the
 * Hocuspocus process, bound to loopback and authenticated with a short-lived
 * service token. It exists so a write that did not come from the editor can
 * reach an *open* editing session instead of racing its next autosave.
 *
 * ProseMirror JSON travels over the wire rather than binary Yjs state: the
 * receiving side has to merge the content into a living document, not install a
 * new one, and the document's own schema is the only thing both sides share.
 */

export const collaborationApplyModeSchema = z.enum(['replace', 'append', 'prepend']);
export type CollaborationApplyMode = z.infer<typeof collaborationApplyModeSchema>;

export const collaborationApplyRequestSchema = z.object({
  /**
   * A ProseMirror `doc` node. Only the outermost shape is checked here so a
   * malformed body fails fast; the node types themselves are validated against
   * the canonical Exocortex schema by the receiver, which is the only place
   * that owns that schema. Restating it here would be a second definition, free
   * to drift.
   */
  proseMirrorJson: z.custom<{ type: 'doc' }>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      (value as { type?: unknown }).type === 'doc',
    { message: 'Expected a ProseMirror doc node' },
  ),
  mode: collaborationApplyModeSchema,
  /** Carried through so both processes log the same request. */
  correlationId: z.string(),
});
export type CollaborationApplyRequest = z.infer<typeof collaborationApplyRequestSchema>;

export const collaborationApplyResponseSchema = z.object({
  /**
   * `false` means the document was not loaded in this process, so there was no
   * live session to update and the caller's database write already stands.
   */
  applied: z.boolean(),
  /** Editors connected to the document, excluding this internal call. */
  clientsCount: z.number().int().nonnegative(),
  /** Set when the applied state was persisted straight away. */
  yjsUpdatedAt: isoDateTimeSchema.nullable(),
});
export type CollaborationApplyResponse = z.infer<typeof collaborationApplyResponseSchema>;

/** Path of the internal endpoint, so caller and server cannot drift apart. */
export function collaborationApplyPath(documentId: string): string {
  return `/internal/documents/${documentId}/content`;
}

export const collaborationApplyParamsSchema = z.object({ documentId: idSchema });
