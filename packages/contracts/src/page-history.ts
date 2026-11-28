import { z } from 'zod';

import { documentDiffNoticeSchema, documentSnapshotSchema } from './documents';
import { idSchema, isoDateTimeSchema } from './primitives';
import { documentMapSchema } from './transclusion';

/**
 * The page history of issue #235: every stored version of one page, with who
 * caused it and grouped the way a person reads a history.
 *
 * A version is a `DocumentSnapshot`. What it *means* depends on its reason,
 * and that is the one thing a reader of this list has to keep straight:
 *
 * - `scheduled` is the page as somebody left it while typing: the state
 *   after their edits, taken at most every few minutes.
 * - `api_write` is the page as it was *before* a write from outside the
 *   editor (an agent, a run of the built-in AI, an import, a template).
 * - `pre_restore` is the page as it was before somebody restored a version,
 *   which is what makes every restore reversible.
 * - `manual` and `import` are what their names say.
 */

/**
 * Who caused a version.
 *
 * Resolved from the agent journal (ADR-022): a snapshot taken before a
 * journalled write names the agent session behind it, and a session of the
 * built-in AI names its run. A version nobody journalled is a person's, and
 * one without any account (an import by a deleted user) is `unknown`.
 */
export const pageHistoryAuthorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('person'),
    userId: idSchema,
    name: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('agent'),
    /** The account the agent acted as. */
    userId: idSchema,
    name: z.string().nullable(),
    /** `clientInfo` the agent announced, verbatim and unverified. */
    clientLabel: z.string().nullable(),
    agentSessionId: idSchema,
  }),
  z.object({
    kind: z.literal('aiRun'),
    /** The person the run acted for. */
    userId: idSchema,
    name: z.string().nullable(),
    runId: idSchema,
  }),
  z.object({ kind: z.literal('unknown') }),
]);
export type PageHistoryAuthor = z.infer<typeof pageHistoryAuthorSchema>;

export const pageHistoryVersionSchema = z.object({
  id: idSchema,
  createdAt: isoDateTimeSchema,
  reason: documentSnapshotSchema.shape.reason,
  author: pageHistoryAuthorSchema,
});
export type PageHistoryVersion = z.infer<typeof pageHistoryVersionSchema>;

/**
 * What a group of versions is, as far as a reader cares.
 *
 * `edit` is typing in the editor, `write` a series of writes from outside it,
 * `restore` a restore, `manual` a version somebody saved by name, `import` an
 * import.
 */
export const pageHistoryGroupKindSchema = z.enum(['edit', 'write', 'restore', 'manual', 'import']);
export type PageHistoryGroupKind = z.infer<typeof pageHistoryGroupKindSchema>;

/**
 * Versions in short succession by the same author, folded into one entry.
 *
 * Nothing is dropped: `versions` holds every member, newest first, and each
 * stays restorable on its own. `representativeId` is the one the entry stands
 * for: for a `write` series the *oldest*, which is the page before the series
 * began, and otherwise the newest, which is the page as the session left it.
 */
export const pageHistoryGroupSchema = z.object({
  id: idSchema,
  kind: pageHistoryGroupKindSchema,
  author: pageHistoryAuthorSchema,
  startedAt: isoDateTimeSchema,
  endedAt: isoDateTimeSchema,
  representativeId: idSchema,
  versions: z.array(pageHistoryVersionSchema).min(1),
});
export type PageHistoryGroup = z.infer<typeof pageHistoryGroupSchema>;

export const pageHistoryQuerySchema = z.object({
  /** Only versions older than this; the `nextBefore` of the previous page. */
  before: isoDateTimeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});
export type PageHistoryQuery = z.infer<typeof pageHistoryQuerySchema>;

export const pageHistoryResponseSchema = z.object({
  documentId: idSchema,
  /** When the page's content last changed, i.e. the current version. */
  currentUpdatedAt: isoDateTimeSchema,
  groups: z.array(pageHistoryGroupSchema),
  /** Versions on this page of the list. */
  versionCount: z.number().int().nonnegative(),
  /**
   * Pass as `before` for the next, older page; `null` when this was the last.
   * A group can straddle two pages, which then show it as two entries.
   */
  nextBefore: isoDateTimeSchema.nullable(),
});
export type PageHistoryResponse = z.infer<typeof pageHistoryResponseSchema>;

export const snapshotContentQuerySchema = z.object({
  /**
   * Over this many characters of Markdown the answer is the version's map, not
   * its text (ADR-056). Absent: the whole version.
   */
  maxChars: z.coerce.number().int().min(1000).max(2_000_000).optional(),
  /** Also send the ProseMirror JSON, which is what the browser renders. */
  content: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export type SnapshotContentQuery = z.input<typeof snapshotContentQuerySchema>;

/** One stored version of a page, readable (issue #235). */
export const snapshotContentResponseSchema = z.object({
  documentId: idSchema,
  version: pageHistoryVersionSchema,
  view: z.enum(['content', 'map']),
  /** Characters of Markdown the version holds, shown or not. */
  chars: z.number().int().nonnegative(),
  markdown: z.string(),
  map: documentMapSchema.nullable(),
  /** `null` unless `content=true` was asked for, and on `view: 'map'`. */
  proseMirrorJson: z
    .custom<{ type: 'doc' }>(
      (value) =>
        typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'doc',
      { message: 'Expected a ProseMirror doc node' },
    )
    .nullable(),
  notices: z.array(documentDiffNoticeSchema),
});
export type SnapshotContentResponse = z.infer<typeof snapshotContentResponseSchema>;

/**
 * `POST /api/documents/:documentId/snapshots/:snapshotId/restore`.
 *
 * `snapshotBeforeId` is the version saved of the page just before the restore
 * replaced it: restoring that one takes the restore back.
 */
export const restoreSnapshotResponseSchema = z.object({
  documentId: idSchema,
  restoredFrom: idSchema,
  snapshotBeforeId: idSchema,
});
export type RestoreSnapshotResponse = z.infer<typeof restoreSnapshotResponseSchema>;
