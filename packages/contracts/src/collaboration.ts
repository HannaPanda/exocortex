import { z } from 'zod';

import { blockRangeEditSchema } from './documents';
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

/**
 * The writer of a change that did not come from the editor.
 *
 * `agent` when the request named an agent session (ADR-022): an MCP client, or
 * the built-in AI, which labels itself. The label is the client's own
 * `clientInfo`, unverified, and is only ever shown to a person -- never used
 * for a decision. `person` is somebody using the REST API directly; the
 * collaboration server puts their name to it.
 */
export const collaborationEditActorSchema = z.object({
  kind: z.enum(['agent', 'person']),
  label: z.string().max(200).nullable(),
});
export type CollaborationEditActor = z.infer<typeof collaborationEditActorSchema>;

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
      typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'doc',
    { message: 'Expected a ProseMirror doc node' },
  ),
  mode: collaborationApplyModeSchema,
  /**
   * Set for a narrow write (issue #111): the blocks the content replaces or is
   * inserted beside, instead of the whole document. `mode` is ignored when this
   * is present, because the placement is part of the range.
   *
   * The range travels as identifiers rather than as positions for the reason
   * ADR-016 exists at all: the live document is not the document the API read.
   * Somebody may have typed three paragraphs above the edit in the meantime,
   * and an index would then address the wrong block, where an identifier still
   * addresses the right one -- or honestly fails, when the block is gone.
   */
  edit: blockRangeEditSchema.nullable().default(null),
  /**
   * Who is writing, so the people with the page open can be told (issue #112).
   * Absent means a person through the REST API.
   */
  actor: collaborationEditActorSchema.default({ kind: 'person', label: null }),
  /** Carried through so both processes log the same request. */
  correlationId: z.string(),
});
export type CollaborationApplyRequest = z.infer<typeof collaborationApplyRequestSchema>;

/**
 * What an open editor is told after such a change (issue #112), as a
 * Hocuspocus stateless message on the document's own socket.
 *
 * The same socket as the Yjs updates rather than the application event bus
 * (ADR-008 keeps those apart for a reason that holds here too): the notice is
 * about this document's content, it needs no authorization beyond the
 * connection that already reads the document, and it arrives after the update
 * it describes, because both travel down the same ordered channel.
 *
 * It is a notice and nothing else. It is never stored, it names blocks and not
 * content, and a client that misses it has lost a highlight, not information.
 */
export const EDIT_NOTICE_TYPE = 'exocortex.edit-notice';

export const collaborationEditNoticeSchema = z.object({
  type: z.literal(EDIT_NOTICE_TYPE),
  /**
   * `changed`: the write reached the page and these blocks differ now.
   * `failed`: the collaboration server refused it (a narrow write whose blocks
   * were gone), and these are the blocks it was aimed at, so nobody reads a
   * successful change into a refusal.
   */
  outcome: z.enum(['changed', 'failed']),
  actorKind: collaborationEditActorSchema.shape.kind,
  /** What to call the writer; `null` when nothing is known about it. */
  actorName: z.string().max(200).nullable(),
  blockIds: z.array(z.string()).max(200),
});
export type CollaborationEditNotice = z.infer<typeof collaborationEditNoticeSchema>;

/** The most blocks one notice names; a whole-page rewrite is cut here. */
export const EDIT_NOTICE_MAX_BLOCKS = 200;

/**
 * What a person should read for an agent's self-description: its name without
 * the version. `claude-code 2.1.4` is Claude Code to the reader, and a version
 * number in a marker beside a paragraph is noise.
 */
export function agentDisplayName(label: string | null): string | null {
  if (label === null) return null;
  const name = label
    .trim()
    .replace(/\s+v?\d[\w.+-]*$/u, '')
    .trim();
  return name === '' ? null : name;
}

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

/**
 * The same bridge for a project's file tree (issue #43, ADR-027).
 *
 * `POST /internal/projects/:projectId/apply`, beside the document endpoint and
 * with the same guards: loopback only, a short-lived service token, and the
 * caller's own write access re-checked by the receiver.
 *
 * One thing differs, and it is deliberate. A page write goes to the database
 * first and is *mirrored* to an open session; a project write goes here and
 * nowhere else. The collaboration server opens the document (loading it from
 * storage when nobody has it open), applies the operation to the CRDT and lets
 * the ordinary persistence hook write it back. Two writers for one Yjs state
 * would mean the API rebuilding a project's binary state from the rows it
 * derived from that same state, which is exactly what ADR-005 forbids.
 */
export const collaborationProjectOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('write'),
    path: z.string(),
    content: z.string(),
    createOnly: z.boolean().default(false),
  }),
  z.object({
    op: z.literal('patch'),
    path: z.string(),
    oldText: z.string(),
    newText: z.string(),
    replaceAll: z.boolean().default(false),
  }),
  z.object({
    op: z.literal('asset'),
    path: z.string(),
    attachmentId: idSchema,
    byteSize: z.number().int().nonnegative(),
    mimeType: z.string().nullable(),
  }),
  /**
   * Many files at once, for an archive import (issue #54).
   *
   * Its own operation rather than a loop over `write` and `asset` at the call
   * site: every apply opens the document, persists it and closes it again, so a
   * thirty-file thesis would rewrite the whole binary state thirty times. One
   * operation is one transaction and one persist, which is also what makes the
   * file limit a single check rather than one that trips halfway through.
   */
  z.object({
    op: z.literal('import'),
    files: z.array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('TEXT'), path: z.string(), content: z.string() }),
        z.object({
          kind: z.literal('ASSET'),
          path: z.string(),
          attachmentId: idSchema,
          byteSize: z.number().int().nonnegative(),
          mimeType: z.string().nullable(),
        }),
      ]),
    ),
    /** Replace a path that is already taken instead of leaving it alone. */
    overwrite: z.boolean().default(false),
  }),
  z.object({
    op: z.literal('move'),
    from: z.string(),
    to: z.string(),
    recursive: z.boolean().default(false),
  }),
  z.object({
    op: z.literal('delete'),
    path: z.string(),
    recursive: z.boolean().default(false),
  }),
]);
export type CollaborationProjectOperation = z.infer<typeof collaborationProjectOperationSchema>;

export const collaborationProjectApplyRequestSchema = z.object({
  operation: collaborationProjectOperationSchema,
  /**
   * Refuse the write when the project would end up with more paths than this.
   * Checked where the tree actually is, because the row projection may be a
   * materialization behind and a limit enforced against stale rows is not one.
   */
  maxFiles: z.number().int().positive(),
  correlationId: z.string(),
});
export type CollaborationProjectApplyRequest = z.infer<
  typeof collaborationProjectApplyRequestSchema
>;

export const collaborationProjectApplyResponseSchema = z.object({
  /** The paths the operation touched, after it was applied. */
  paths: z.array(z.string()),
  /** Editors connected to the project, excluding this internal call. */
  clientsCount: z.number().int().nonnegative(),
  /** True when somebody had the project open, so the change was seen live. */
  live: z.boolean(),
  yjsUpdatedAt: isoDateTimeSchema.nullable(),
});
export type CollaborationProjectApplyResponse = z.infer<
  typeof collaborationProjectApplyResponseSchema
>;

/** Path of the internal project endpoint, so caller and server cannot drift. */
export function collaborationProjectApplyPath(projectId: string): string {
  return `/internal/projects/${projectId}/apply`;
}
