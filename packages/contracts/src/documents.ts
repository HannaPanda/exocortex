import { z } from 'zod';

import {
  collaborationAccessSchema,
  creatableDocumentTypeSchema,
  DOCUMENT_ICON_COLORS,
  documentIconColorSchema,
  documentIconSchema,
  documentTitleSchema,
  documentTypeSchema,
  idSchema,
  isoDateTimeSchema,
} from './primitives';
import { blockIdSchema, documentMapSchema } from './transclusion';

/**
 * How wide the page body is rendered. `narrow` is the 68ch reading measure,
 * `wide` roughly doubles it for pages that carry tables, and `full` uses the
 * whole available width (the default for databases).
 */
export const documentLayoutSchema = z.enum(['narrow', 'wide', 'full']);
export type DocumentLayout = z.infer<typeof documentLayoutSchema>;

export const createDocumentRequestSchema = z.object({
  title: documentTitleSchema.default('Unbenannte Seite'),
  parentId: idSchema.nullable().optional(),
  type: creatableDocumentTypeSchema.default('PAGE'),
  icon: documentIconSchema,
  iconColor: documentIconColorSchema,
  /**
   * Omitted means the server picks the default for the type: `full` for a
   * database, `narrow` for a page.
   */
  layout: documentLayoutSchema.optional(),
  /**
   * Optional sibling anchors. The server derives the fractional `orderKey`
   * itself; clients never send an order key.
   */
  afterSiblingId: idSchema.nullable().optional(),
  beforeSiblingId: idSchema.nullable().optional(),
});
export type CreateDocumentRequest = z.infer<typeof createDocumentRequestSchema>;

export const aiRuleModeSchema = z.enum(['off', 'always', 'on_demand']);
export type AiRuleMode = z.infer<typeof aiRuleModeSchema>;

/**
 * Whether a page is an overview of its sub-pages (issue #53, ADR-028).
 *
 * `auto` means the page lists its children and, when a model is available,
 * opens with a composed paragraph. Neither is written into the page body: the
 * composition is a derived view beside it, so switching this back to `off`
 * takes nothing away that a human wrote.
 */
export const overviewModeSchema = z.enum(['off', 'auto']);
export type OverviewMode = z.infer<typeof overviewModeSchema>;

/**
 * Vertical crop of the cover image, in percent of its height: 0 shows the top
 * edge, 100 the bottom, 50 the middle. The cover is always full width at a
 * fixed height, so this is the only framing decision a page offers.
 */
export const coverPositionSchema = z.number().min(0).max(100);

/**
 * Asking the AI to draw a cover.
 *
 * Answered before the picture exists: drawing takes tens of seconds, so the
 * request only enqueues the work and the page learns the outcome from the
 * `document.cover.generated` event.
 */
export const generateDocumentCoverRequestSchema = z.object({
  prompt: z.string().trim().min(3).max(1_000),
});
export type GenerateDocumentCoverRequest = z.infer<typeof generateDocumentCoverRequestSchema>;

export const generateDocumentCoverResponseSchema = z.object({
  status: z.literal('pending'),
  documentId: idSchema,
});
export type GenerateDocumentCoverResponse = z.infer<typeof generateDocumentCoverResponseSchema>;

const updateDocumentFieldsSchema = z.object({
  title: documentTitleSchema.optional(),
  icon: documentIconSchema,
  iconColor: documentIconColorSchema,
  layout: documentLayoutSchema.optional(),
  /** An image attachment of the same workspace, or `null` to remove the cover. */
  coverAttachmentId: idSchema.nullable().optional(),
  coverPosition: coverPositionSchema.optional(),
  aiRuleMode: aiRuleModeSchema.optional(),
  aiRuleTrigger: z.string().trim().max(300).nullable().optional(),
  aiRulePriority: z.number().int().optional(),
  overviewMode: overviewModeSchema.optional(),
});
export const updateDocumentRequestSchema = updateDocumentFieldsSchema.refine(
  (value) =>
    value.title !== undefined ||
    value.icon !== undefined ||
    value.iconColor !== undefined ||
    value.layout !== undefined ||
    value.coverAttachmentId !== undefined ||
    value.coverPosition !== undefined ||
    value.aiRuleMode !== undefined ||
    value.aiRuleTrigger !== undefined ||
    value.aiRulePriority !== undefined ||
    value.overviewMode !== undefined,
  { message: 'At least one field must be provided' },
);
export type UpdateDocumentRequest = z.infer<typeof updateDocumentRequestSchema>;

export const moveDocumentRequestSchema = z.object({
  parentId: idSchema.nullable(),
  afterSiblingId: idSchema.nullable().optional(),
  beforeSiblingId: idSchema.nullable().optional(),
  /**
   * Moves the whole subtree into a different workspace. Omitted (the default)
   * keeps today's behaviour: `parentId` must then name a document of the same
   * workspace the moved document is already in. When given, `parentId` (unless
   * `null`) must instead name a document of *this* workspace, the caller needs
   * write access in both workspaces, and every descendant moves along with it.
   */
  workspaceId: idSchema.optional(),
});
export type MoveDocumentRequest = z.infer<typeof moveDocumentRequestSchema>;

export const documentSummarySchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  parentId: idSchema.nullable(),
  type: documentTypeSchema,
  title: z.string(),
  icon: z.string().nullable(),
  iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable(),
  layout: documentLayoutSchema,
  /** See `overviewModeSchema`. In the summary so a tree can mark one. */
  overviewMode: overviewModeSchema,
  coverAttachmentId: idSchema.nullable(),
  coverPosition: coverPositionSchema,
  orderKey: z.string(),
  createdById: idSchema,
  updatedById: idSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  archivedAt: isoDateTimeSchema.nullable(),
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const documentTreeNodeSchema: z.ZodType<DocumentTreeNode> = z.lazy(() =>
  documentSummarySchema.extend({
    children: z.array(documentTreeNodeSchema),
  }),
);
export interface DocumentTreeNode extends DocumentSummary {
  children: DocumentTreeNode[];
}

/**
 * One step of the chain of ancestors above a page, root first.
 *
 * A bare title is not an address: a workspace can hold three pages called
 * "Rezepte" under three different sections. Anything that hands a page to a
 * reader who cannot see the sidebar — search results, an export, an MCP tool
 * result — has to say where it sits, or the reader has to guess, and it will
 * guess the section it happened to read last.
 */
export const documentPathEntrySchema = z.object({
  id: idSchema,
  title: z.string(),
});
export type DocumentPathEntry = z.infer<typeof documentPathEntrySchema>;

export const documentTreeRequestSchema = z.object({
  /**
   * Answers with the subtree under this document instead of the whole
   * workspace. Without it the tree is capped by whatever renders it, and a
   * capped tree needs a way to ask about the part that was cut.
   */
  parentId: idSchema.optional(),
  /** How many levels below the starting point to include. Omitted: all of them. */
  depth: z.coerce.number().int().min(1).max(20).optional(),
});
export type DocumentTreeRequest = z.infer<typeof documentTreeRequestSchema>;

export const documentTreeResponseSchema = z.object({
  nodes: z.array(documentTreeNodeSchema),
  /** Archived documents are returned flat so the trash view can list them. */
  archived: z.array(documentSummarySchema),
  /**
   * The chain from the root down to and including `parentId`, so the answer
   * says which branch it is. Empty for a whole-workspace tree.
   */
  path: z.array(documentPathEntrySchema),
  /**
   * Active documents in the answered scope, including the ones `depth` cut off.
   * A renderer that truncates needs to know what it is truncating.
   */
  totalCount: z.number().int().nonnegative(),
});
export type DocumentTreeResponse = z.infer<typeof documentTreeResponseSchema>;

/**
 * Archiving a page archives everything under it. The caller is told which
 * pages went along, because a caller that is not a human looking at a sidebar
 * cannot see it happen, and "Seite archiviert: Rezepte" reads like one page
 * when it was eight.
 */
export const archiveDocumentResponseSchema = documentSummarySchema.extend({
  archivedDescendants: z.array(documentSummarySchema),
});
export type ArchiveDocumentResponse = z.infer<typeof archiveDocumentResponseSchema>;

/**
 * Why a page sits in the trash.
 *
 * `direct` means somebody archived this page. `cascade` means it went along
 * because the page above it was archived in the same operation — it was never
 * chosen, and that is the difference between "I threw this away" and "I threw
 * away the folder it happened to be in".
 */
export const trashReasonSchema = z.enum(['direct', 'cascade']);
export type TrashReason = z.infer<typeof trashReasonSchema>;

/**
 * One archived page, with the archived pages that hang below it.
 *
 * The trash keeps its shape. A flat list of 145 titles cannot answer "did this
 * page have anything under it", and that is the question somebody deciding what
 * may go for good has to answer first.
 */
export const trashEntrySchema: z.ZodType<TrashEntry> = z.lazy(() =>
  documentSummarySchema.extend({
    /** Never null in the trash: everything here has been archived. */
    archivedAt: isoDateTimeSchema,
    reason: trashReasonSchema,
    /** Archived pages below this one, at any depth. */
    descendantCount: z.number().int().nonnegative(),
    children: z.array(trashEntrySchema),
  }),
);
export interface TrashEntry extends DocumentSummary {
  archivedAt: string;
  reason: TrashReason;
  descendantCount: number;
  children: TrashEntry[];
}

export const trashResponseSchema = z.object({
  /**
   * The roots of the trash: archived pages whose parent is not itself archived.
   * Newest operation first, because the trash is read from the recent end.
   */
  entries: z.array(trashEntrySchema),
  /** Every archived page in the workspace, including the nested ones. */
  totalCount: z.number().int().nonnegative(),
});
export type TrashResponse = z.infer<typeof trashResponseSchema>;

/**
 * What deleting a page for good would take with it.
 *
 * Deletion is the one step this application cannot undo, so the answer to
 * "what happens if I do this" must exist before it happens — for the dialog
 * that asks a human, and for the confirmation an agent has to read back.
 */
export const documentDeletionPreviewSchema = z.object({
  documentId: idSchema,
  title: z.string(),
  /** The page itself first, then everything below it. */
  documents: z.array(documentSummarySchema),
  /** Pages below the named one. `documents.length` is this plus one. */
  descendantCount: z.number().int().nonnegative(),
  /** Files that go with them, including the objects in storage. */
  attachmentCount: z.number().int().nonnegative(),
  /**
   * References from pages that stay. They are not deleted: they turn into
   * unresolved references, the same state a `[[Titel]]` has before its page
   * exists. A reader following one lands on "not found", not on nothing.
   */
  incomingLinkCount: z.number().int().nonnegative(),
});
export type DocumentDeletionPreview = z.infer<typeof documentDeletionPreviewSchema>;

/**
 * One preview per page named in the request, in the same order.
 *
 * Overlapping selections are the caller's job to avoid: asking about a page and
 * about a page below it counts the shared subtree twice. The trash view never
 * offers that, because selecting a page covers everything under it.
 */
export const documentDeletionPreviewsResponseSchema = z.object({
  previews: z.array(documentDeletionPreviewSchema),
});
export type DocumentDeletionPreviewsResponse = z.infer<
  typeof documentDeletionPreviewsResponseSchema
>;

export const deleteDocumentsRequestSchema = z.object({
  /**
   * Capped so one request cannot walk the whole workspace. Emptying a large
   * trash takes several rounds, and each of them is a decision.
   */
  documentIds: z.array(idSchema).min(1).max(100),
});
export type DeleteDocumentsRequest = z.infer<typeof deleteDocumentsRequestSchema>;

export const deleteDocumentsResponseSchema = z.object({
  /** Ids that no longer exist, descendants included. */
  deletedIds: z.array(idSchema),
  deletedCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  /** References that became unresolved because their target is gone. */
  unresolvedLinkCount: z.number().int().nonnegative(),
});
export type DeleteDocumentsResponse = z.infer<typeof deleteDocumentsResponseSchema>;

/**
 * Resolves a reference to another page to the document(s) it means.
 *
 * Two ways in, and they are tried in that order: `documentId`, the identity a
 * `pageLink` block, a `[[Titel]]` link mark and a page mention all store, and
 * `title`, which every one of them carries as its label. Identity first is what
 * makes renaming a page harmless; the title is the fallback that keeps a
 * reference alive when its target was deleted and written again, and the only
 * thing a reference typed by hand has until it is bound to a page.
 *
 * Deliberately not the fuzzy `/search` endpoint: following a link must be
 * deterministic (exact title or nothing) and must not depend on the
 * asynchronous search index having caught up with a page just created or
 * renamed.
 */
export const resolveDocumentLinkRequestSchema = z
  .object({
    /** Optional only when `documentId` is given; both together is the normal case. */
    title: documentTitleSchema.optional(),
    /** Identity of the target, when the reference carries one. */
    documentId: idSchema.optional(),
    /**
     * An archived page is still a real target for a link (read-only view), so
     * this defaults to `true` — defaulting to `false` would report a dead link
     * for a page that in fact exists.
     */
    includeArchived: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((value) => value === true || value === 'true')
      .default(true),
    limit: z.coerce.number().int().min(1).max(20).default(10),
  })
  .refine((value) => value.title !== undefined || value.documentId !== undefined, {
    message: 'Either title or documentId is required',
  });
export type ResolveDocumentLinkRequest = z.infer<typeof resolveDocumentLinkRequestSchema>;

export const documentLinkMatchSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  type: documentTypeSchema,
  title: z.string(),
  icon: z.string().nullable(),
  iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
  /** Ancestors from the root downwards. Only filled when there is more than one match. */
  path: z.array(z.object({ id: idSchema, title: z.string() })),
});
export type DocumentLinkMatch = z.infer<typeof documentLinkMatchSchema>;

export const resolveDocumentLinkResponseSchema = z.object({
  /**
   * The normalized title that was looked up. When only a `documentId` was
   * given, the title that document carries — which is exactly what a caller
   * needs in order to refresh a stale label.
   */
  title: z.string(),
  matches: z.array(documentLinkMatchSchema),
  /**
   * Which of the two given values produced the matches: `id` when the stored
   * identity still names a document, `title` when the title had to stand in
   * for it (a link made before identities, or a target that was deleted and
   * written again), `none` when neither resolved to anything.
   */
  resolvedBy: z.enum(['id', 'title', 'none']),
});
export type ResolveDocumentLinkResponse = z.infer<typeof resolveDocumentLinkResponseSchema>;

// --------------------------------------------------------------------------
// Reference index (backlinks)
// --------------------------------------------------------------------------

/**
 * Which notation produced a reference: the page-link block, an inline mention
 * or a `[[Titel]]` / `wiki:` link mark. Mirrors `DOCUMENT_LINK_KINDS` in
 * `@exocortex/editor` and the `DocumentLinkKind` enum in the database.
 */
export const documentLinkKindSchema = z.enum(['pageLink', 'mention', 'wikiMark']);
export type DocumentLinkKind = z.infer<typeof documentLinkKindSchema>;

/** The other end of a reference, as much of it as a list needs. */
export const documentLinkEndpointSchema = z.object({
  id: idSchema,
  title: z.string(),
  type: documentTypeSchema,
  icon: z.string().nullable(),
  iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable(),
  archivedAt: isoDateTimeSchema.nullable(),
});
export type DocumentLinkEndpoint = z.infer<typeof documentLinkEndpointSchema>;

const documentLinkBaseSchema = z.object({
  id: idSchema,
  kind: documentLinkKindSchema,
  /** Title as written in the source document. */
  targetTitle: z.string(),
  /** Addressable block the reference sits in, when it carries an identifier. */
  blockId: z.string().nullable(),
  /** Surrounding sentence, for the preview. May be empty. */
  context: z.string(),
});

/** A reference pointing *at* the requested document. */
export const incomingDocumentLinkSchema = documentLinkBaseSchema.extend({
  source: documentLinkEndpointSchema,
});
export type IncomingDocumentLink = z.infer<typeof incomingDocumentLinkSchema>;

/**
 * A reference the requested document makes. `target` is null while no page
 * carries `targetTitle`, which is how an orphaned reference stays visible
 * instead of disappearing.
 */
export const outgoingDocumentLinkSchema = documentLinkBaseSchema.extend({
  target: documentLinkEndpointSchema.nullable(),
});
export type OutgoingDocumentLink = z.infer<typeof outgoingDocumentLinkSchema>;

export const documentLinksResponseSchema = z.object({
  documentId: idSchema,
  incoming: z.array(incomingDocumentLinkSchema),
  outgoing: z.array(outgoingDocumentLinkSchema),
  /**
   * True when the reference index has not run over this page yet, so an empty
   * `outgoing` means "not looked at" rather than "nothing there". The UI says
   * so instead of claiming the page references nothing.
   */
  pending: z.boolean(),
});
export type DocumentLinksResponse = z.infer<typeof documentLinksResponseSchema>;

/**
 * A page that resembles the requested one without referencing it (issue #33).
 *
 * `similarity` is cosine similarity between the two stored embeddings, so it is
 * comparable between rows of one answer but says nothing absolute: it is shown
 * to let a reader tell a close match from a distant one, not as a percentage of
 * anything.
 */
export const relatedDocumentSchema = z.object({
  document: documentLinkEndpointSchema,
  /** Ancestors of the page, root first, so two pages with one title stay apart. */
  path: z.array(documentPathEntrySchema),
  /** Opening of the page's text, unhighlighted: there is no query to highlight. */
  snippet: z.string(),
  similarity: z.number(),
  /** True when this page is already referenced from or to the open one. */
  linked: z.boolean(),
});
export type RelatedDocument = z.infer<typeof relatedDocumentSchema>;

/**
 * Why an answer can be empty, which is most of what this endpoint has to
 * explain. Three different silences read identically in a list and would
 * otherwise all look like "nothing resembles this page":
 *
 * `disabled`  semantic search is switched off, so no vectors are being written
 * `pending`   this page has no vector yet (never indexed, or just edited)
 * `ready`     the comparison ran; an empty list means nothing was close enough
 */
export const relatedDocumentsStateSchema = z.enum(['ready', 'pending', 'disabled']);
export type RelatedDocumentsState = z.infer<typeof relatedDocumentsStateSchema>;

export const relatedDocumentsResponseSchema = z.object({
  documentId: idSchema,
  state: relatedDocumentsStateSchema,
  related: z.array(relatedDocumentSchema),
});
export type RelatedDocumentsResponse = z.infer<typeof relatedDocumentsResponseSchema>;

export const documentDetailSchema = documentSummarySchema.extend({
  /** Access level the requesting user has for this document. */
  access: collaborationAccessSchema,
  breadcrumb: z.array(
    z.object({
      id: idSchema,
      title: z.string(),
      icon: z.string().nullable(),
      iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable(),
    }),
  ),
  materializedAt: isoDateTimeSchema.nullable(),
  schemaVersion: z.number().int().nonnegative(),
  aiRuleMode: aiRuleModeSchema,
  aiRuleTrigger: z.string().nullable(),
  aiRulePriority: z.number().int(),
  /** Display name of `createdById`, so the context panel can show who without a second lookup. */
  createdByName: z.string(),
  /** Display name of `updatedById`. */
  updatedByName: z.string(),
  /**
   * `type` of the parent document, or `null` at the workspace root. Distinguishes
   * a database row (`parentType: 'COLLECTION'`) from an ordinary sub-page
   * (`parentType: 'PAGE'`) without a second request — the context panel's
   * properties tab needs exactly this to decide whether to show row properties
   * (ADR-011: a row is a `PAGE` whose parent is a `COLLECTION`).
   */
  parentType: documentTypeSchema.nullable(),
  /**
   * Number of active (non-archived) rows, when this document is itself a
   * database (`type: 'COLLECTION'`); `null` for a plain page, for which the
   * question does not apply.
   */
  rowCount: z.number().int().nonnegative().nullable(),
  /**
   * Whether this reader may hand the page to somebody outside the workspace
   * (issue #83, ADR-044).
   *
   * Two conditions in one flag, because the UI asks one question: the reader
   * has to be a *member* of the workspace rather than somebody who was handed
   * the page themselves -- a share cannot be passed on -- and they have to be
   * an ADMIN or OWNER, which is the bar for changing who the workspace is.
   */
  canShare: z.boolean(),
  /**
   * True when this reader is here through a share rather than a membership.
   *
   * The browser needs it because a shared page is opened outside the workspace
   * shell: there is no tree, no inbox and no workspace name to show, and a
   * page that tried would spend its first second on three refused requests.
   */
  viaShare: z.boolean(),
});
export type DocumentDetail = z.infer<typeof documentDetailSchema>;

export const collaborationTicketResponseSchema = z.object({
  /** Signed, short-lived ticket. Opaque to the client. */
  ticket: z.string().min(20),
  /** Opaque Hocuspocus document name. Contains no permission information. */
  documentName: z.string().min(8),
  access: collaborationAccessSchema,
  expiresAt: z.number().int().positive(),
  collaborationUrl: z.string().min(3),
});
export type CollaborationTicketResponse = z.infer<typeof collaborationTicketResponseSchema>;

export const markdownExportResponseSchema = z.object({
  documentId: idSchema,
  /**
   * The revision this answer was read at (issue #120).
   *
   * `DocumentContent.yjsUpdatedAt`, which is the one value a write compares
   * `expectedYjsUpdatedAt` against. It travels on the read because it is the
   * only way a caller can send a correct one: the frontmatter's `updatedAt` is
   * the `document` row's own timestamp, it moves when a page is renamed and
   * stands still when only the content changes, and using it produced a
   * `document_content_conflict` on every read-then-write.
   */
  yjsUpdatedAt: isoDateTimeSchema,
  filename: z.string(),
  /**
   * `content` carries the page, `map` carries its structure instead because
   * the caller named a budget the page does not fit into (issue #118). A
   * caller that names no budget always gets the page, which is what an export
   * is for.
   */
  view: z.enum(['content', 'map']),
  /** Characters of Markdown the page holds, shown or not. */
  chars: z.number().int().nonnegative(),
  /** The parts of the page, on `view: 'map'`. `null` otherwise. */
  map: documentMapSchema.nullable(),
  markdown: z.string(),
  /** Ancestors of this page, root first. */
  path: z.array(documentPathEntrySchema),
  /**
   * The page's direct child pages, active ones only.
   *
   * Markdown carries none of them: a section page whose body lists its topics
   * as prose looks complete, and a reader that only gets the body concludes
   * the prose *is* the structure. It is not; the children are.
   */
  children: z.array(documentSummarySchema),
});
export type MarkdownExportResponse = z.infer<typeof markdownExportResponseSchema>;

export const markdownImportRequestSchema = z.object({
  markdown: z.string().min(1).max(2_000_000),
  parentId: idSchema.nullable().optional(),
  /** Falls back to the frontmatter title, then to the first heading. */
  title: documentTitleSchema.optional(),
  /**
   * The caller's icon wins over one in the frontmatter: the request is the more
   * deliberate of the two, the same way `title` above overrules the file.
   */
  icon: documentIconSchema,
  iconColor: documentIconColorSchema,
});
export type MarkdownImportRequest = z.infer<typeof markdownImportRequestSchema>;

export const markdownImportResponseSchema = z.object({
  document: documentSummarySchema,
});
export type MarkdownImportResponse = z.infer<typeof markdownImportResponseSchema>;

export const documentSnapshotSchema = z.object({
  id: idSchema,
  documentId: idSchema,
  schemaVersion: z.number().int().nonnegative(),
  createdById: idSchema.nullable(),
  /** Null once the user who took it is gone (`onDelete: SetNull`). */
  createdByName: z.string().nullable(),
  reason: z.enum(['manual', 'scheduled', 'pre_restore', 'import', 'restore', 'api_write']),
  createdAt: isoDateTimeSchema,
  byteSize: z.number().int().nonnegative(),
});
export type DocumentSnapshot = z.infer<typeof documentSnapshotSchema>;

export const documentSnapshotListResponseSchema = z.object({
  snapshots: z.array(documentSnapshotSchema),
});
export type DocumentSnapshotListResponse = z.infer<typeof documentSnapshotListResponseSchema>;

export const createSnapshotRequestSchema = z.object({
  reason: z.enum(['manual']).default('manual'),
});
export type CreateSnapshotRequest = z.infer<typeof createSnapshotRequestSchema>;

/**
 * The comparison of two states of one page (issue #77).
 *
 * `from` is always a snapshot; `to` is either a second snapshot or the state
 * the page holds right now. The direction matters: "added" means present in
 * `to` and not in `from`, so a diff against the current state reads as what
 * happened since.
 *
 * The unit is the top-level block, matched on its stable identifier. That is
 * what keeps a moved block from being reported as a deletion plus an unrelated
 * insertion, and it is what makes a single block restorable afterwards. See
 * `packages/editor/src/document-diff.ts`.
 *
 * A snapshot holds the page's content and nothing else, so a title or a
 * database property has no second state here to compare against. Those changes
 * are in the activity timeline (`renamed`), which is where a reader already
 * looks for them.
 */
export const documentDiffRequestSchema = z.object({
  /** The snapshot to compare against, or the page's current content. */
  against: z.union([idSchema, z.literal('current')]).default('current'),
});
export type DocumentDiffRequest = z.infer<typeof documentDiffRequestSchema>;

export const documentDiffSegmentSchema = z.object({
  kind: z.enum(['equal', 'inserted', 'removed']),
  text: z.string(),
});
export type DocumentDiffSegment = z.infer<typeof documentDiffSegmentSchema>;

export const documentDiffBlockSchema = z.object({
  kind: z.enum(['added', 'removed', 'changed', 'unchanged']),
  /** Independent of `kind`: a block can move and change in the same edit. */
  moved: z.boolean(),
  /** `null` for a block that carries no identifier; it cannot be restored alone. */
  blockId: idSchema.nullable(),
  nodeType: z.string(),
  /**
   * German name of the block type, e.g. "Absatz", for the agent-facing text
   * of `exo_page_snapshot_diff`. The browser names `nodeType` from its own
   * catalogue (`document.snapshotDiff.blockTypes`) in the reader's language.
   */
  nodeLabel: z.string(),
  beforeIndex: z.number().int().nonnegative().nullable(),
  afterIndex: z.number().int().nonnegative().nullable(),
  beforeText: z.string().nullable(),
  afterText: z.string().nullable(),
  /** Word-level diff; filled for `changed` blocks, empty otherwise. */
  segments: z.array(documentDiffSegmentSchema),
  /** True when the block was too long to diff word by word. */
  coarse: z.boolean(),
});
export type DocumentDiffBlock = z.infer<typeof documentDiffBlockSchema>;

/**
 * One thing a comparison could not do.
 *
 * `older_schema`: a state was written under an older schema version, so some
 * blocks may look different from how they looked then. `truncated`: the page
 * has more blocks than the comparison reports.
 */
export const documentDiffNoticeSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('older_schema'), stateCreatedAt: isoDateTimeSchema }),
  z.object({ code: z.literal('truncated') }),
]);
export type DocumentDiffNotice = z.infer<typeof documentDiffNoticeSchema>;

export const documentDiffResponseSchema = z.object({
  documentId: idSchema,
  /** The older of the two states; always a snapshot. */
  fromSnapshotId: idSchema,
  fromCreatedAt: isoDateTimeSchema,
  /** `null` when the newer state is the page's current content. */
  toSnapshotId: idSchema.nullable(),
  toCreatedAt: isoDateTimeSchema,
  blocks: z.array(documentDiffBlockSchema),
  summary: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    moved: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
  }),
  /** True when the page had more blocks than the diff reports. */
  truncated: z.boolean(),
  /**
   * What the comparison could not do, as codes (issue #98): each client words
   * them in its reader's language, the browser from `document.snapshotDiff`.
   */
  notices: z.array(documentDiffNoticeSchema),
});
export type DocumentDiffResponse = z.infer<typeof documentDiffResponseSchema>;

/**
 * Takes selected blocks of a snapshot back into the page's *current* content.
 *
 * One rule decides per identifier, so the caller never has to say which kind
 * of change it is undoing: present in the snapshot, the block is written into
 * the page (replaced where it still exists, re-inserted next to its old
 * neighbour where it does not); absent from the snapshot, the block is taken
 * out of the page, which is what reverting an insertion means.
 *
 * Always applied to what the page holds now, never to the state the diff was
 * rendered against. A full restore stays available and unchanged.
 */
export const restoreSnapshotBlocksRequestSchema = z.object({
  blockIds: z.array(idSchema).min(1).max(500),
});
export type RestoreSnapshotBlocksRequest = z.infer<typeof restoreSnapshotBlocksRequestSchema>;

export const restoreSnapshotBlocksResponseSchema = z.object({
  documentId: idSchema,
  snapshotId: idSchema,
  /**
   * Snapshot of the state *before* this partial restore; restore it to undo.
   * `null` when the selection changed nothing, in which case nothing was
   * written and no snapshot was taken.
   */
  snapshotBeforeId: idSchema.nullable(),
  /** Identifiers written back into the page. */
  restored: z.array(idSchema),
  /** Identifiers taken out of the page, because the snapshot had none. */
  removed: z.array(idSchema),
  /** Identifiers neither state knows; nothing was done for them. */
  missing: z.array(idSchema),
  appliedToLiveSession: z.boolean(),
});
export type RestoreSnapshotBlocksResponse = z.infer<typeof restoreSnapshotBlocksResponseSchema>;

/**
 * The page's own history (issue #20), merged server-side from three sources
 * that are each incomplete on their own:
 *
 * - `DocumentSnapshot` (`snapshot`): a restorable version, including the ones
 *   taken automatically before a write from outside the editor.
 * - `AuditLog` (`renamed`, `moved`, `archived`, `restored`, `snapshotRestored`):
 *   the heikle operations already audited there, plus `renamed`, added
 *   alongside this feature because a title has no other history.
 * - `Document.createdAt`/`createdById` (`created`): a document is created
 *   exactly once, so the row itself is the whole history for this entry.
 * - `editingSession`: a condensed range derived from the timestamps above,
 *   not a fourth persisted source (see `document-activity.service.ts`).
 *
 * Deliberately **not** what `AuditLog`'s own doc comment scopes it to
 * ("destructive and permission-relevant operations, must never contain
 * document contents or secrets"): every variant below carries structural
 * metadata only (who, when, a title, a byte size), never page content.
 */
export const documentActivityEntrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('created'),
    id: z.string(),
    occurredAt: isoDateTimeSchema,
    actorId: idSchema.nullable(),
    actorName: z.string().nullable(),
  }),
  z.object({
    type: z.literal('renamed'),
    id: z.string(),
    occurredAt: isoDateTimeSchema,
    actorId: idSchema.nullable(),
    actorName: z.string().nullable(),
    previousTitle: z.string().nullable(),
    nextTitle: z.string().nullable(),
  }),
  z.object({
    type: z.literal('moved'),
    id: z.string(),
    occurredAt: isoDateTimeSchema,
    actorId: idSchema.nullable(),
    actorName: z.string().nullable(),
    acrossWorkspace: z.boolean(),
  }),
  z.object({
    type: z.literal('archived'),
    id: z.string(),
    occurredAt: isoDateTimeSchema,
    actorId: idSchema.nullable(),
    actorName: z.string().nullable(),
  }),
  z.object({
    type: z.literal('restored'),
    id: z.string(),
    occurredAt: isoDateTimeSchema,
    actorId: idSchema.nullable(),
    actorName: z.string().nullable(),
  }),
  z.object({
    type: z.literal('snapshotRestored'),
    id: z.string(),
    occurredAt: isoDateTimeSchema,
    actorId: idSchema.nullable(),
    actorName: z.string().nullable(),
    restoredFromSnapshotId: idSchema,
  }),
  /**
   * A grant on this page was handed out or withdrawn (issue #83, ADR-044).
   *
   * In the page's own history rather than only in the share list, because
   * "when did this page become readable from outside" is a question about the
   * page. `kind` says whether it was a link or an account; who the account was
   * is deliberately left out -- that is in the share list, which is where
   * somebody is already looking at recipients.
   */
  z.object({
    type: z.literal('shared'),
    id: z.string(),
    occurredAt: isoDateTimeSchema,
    actorId: idSchema.nullable(),
    actorName: z.string().nullable(),
    kind: z.enum(['USER', 'PUBLIC_LINK']),
    revoked: z.boolean(),
  }),
  z.object({
    type: z.literal('snapshot'),
    /** The snapshot's own id; what `exo_page_restore_snapshot` takes. */
    id: idSchema,
    occurredAt: isoDateTimeSchema,
    actorId: idSchema.nullable(),
    actorName: z.string().nullable(),
    reason: documentSnapshotSchema.shape.reason,
    byteSize: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('editingSession'),
    id: z.string(),
    startedAt: isoDateTimeSchema,
    endedAt: isoDateTimeSchema,
    actorId: idSchema.nullable(),
    actorName: z.string().nullable(),
  }),
]);
export type DocumentActivityEntry = z.infer<typeof documentActivityEntrySchema>;

export const documentActivityResponseSchema = z.object({
  entries: z.array(documentActivityEntrySchema),
});
export type DocumentActivityResponse = z.infer<typeof documentActivityResponseSchema>;

/**
 * Writes Markdown into an existing document's canonical Yjs state (D8). The
 * only new write path outside the collaboration server; used by humans through
 * the REST API and by the built-in AI / MCP tools.
 */
export const documentContentWriteRequestSchema = z.object({
  markdown: z.string().max(2_000_000),
  mode: z.enum(['replace', 'append', 'prepend']).default('replace'),
  /**
   * Optimistic concurrency: the `yjsUpdatedAt` the caller last read. The write
   * is rejected with `document_content_conflict` when the document changed in
   * the meantime. Omit to write unconditionally.
   */
  expectedYjsUpdatedAt: isoDateTimeSchema.optional(),
});
export type DocumentContentWriteRequest = z.infer<typeof documentContentWriteRequestSchema>;

export const documentContentWriteResponseSchema = z.object({
  documentId: idSchema,
  /** Snapshot of the state *before* this write. Restore it to undo. */
  snapshotId: idSchema,
  yjsUpdatedAt: isoDateTimeSchema,
  schemaVersion: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative(),
  /**
   * `true` when the page was open in at least one editor and that live session
   * was updated with this write, so the change is on screen already and cannot
   * be overwritten by the session's next autosave (ADR-016). `false` simply
   * means nobody had the page open.
   */
  appliedToLiveSession: z.boolean(),
  /** German warnings, e.g. about content the Markdown round-trip simplified. */
  warnings: z.array(z.string()),
});
export type DocumentContentWriteResponse = z.infer<typeof documentContentWriteResponseSchema>;

/**
 * Which blocks a narrow write addresses (issue #111).
 *
 * Mirrors `BlockRangeEdit` in `@exocortex/editor`, which owns the behaviour.
 * The two packages are both leaves and neither may import the other, so the
 * shape is written twice on purpose; it is three fields long, and the API
 * passes one straight into the other, which is where a drift would surface.
 */
export const blockRangeEditSchema = z.object({
  fromBlockId: blockIdSchema,
  toBlockId: blockIdSchema.nullable().default(null),
  placement: z.enum(['replace', 'before', 'after']),
});
export type BlockRangeEdit = z.infer<typeof blockRangeEditSchema>;

/**
 * Replacing one block, or inserting beside it
 * (`POST /api/documents/:documentId/content/block`, issue #111).
 *
 * The primitive the other two are built on, and the one to reach for when the
 * caller already read the page: `exo_page_read` hands out block identifiers,
 * and this turns one of them back into an edit that leaves the other four
 * hundred blocks of the page exactly as they are -- same identifiers, same Yjs
 * history, including whatever somebody typed while this call was being thought
 * about.
 *
 * A heading addresses only itself here. That is the opposite of a transclusion,
 * where a heading stands for its whole section (ADR-045), and it is deliberate:
 * this tool's promise is "exactly one block", and a caller that means the
 * section has `section` below to say so.
 */
export const documentBlockWriteRequestSchema = z.object({
  blockId: blockIdSchema,
  markdown: z.string().max(200_000),
  /** `replace` swaps the block out; `append`/`prepend` insert after/before it. */
  mode: z.enum(['replace', 'append', 'prepend']).default('replace'),
  expectedYjsUpdatedAt: isoDateTimeSchema.optional(),
});
export type DocumentBlockWriteRequest = z.infer<typeof documentBlockWriteRequestSchema>;

/**
 * Replacing a piece of text (`POST /api/documents/:documentId/content/patch`).
 *
 * Modelled on `exo_project_patch_file`, including the part that matters: a
 * target that is not unique is not disambiguated, it is refused, and nothing is
 * written. `oldText` is matched against the page's Markdown, which is the
 * string `exo_page_read` answers with, so a caller can copy a line out of what
 * it read and send it back.
 */
export const documentPatchRequestSchema = z.object({
  oldText: z.string().min(1).max(100_000),
  newText: z.string().max(100_000),
  /** Allow several matches. Without it, anything but exactly one is refused. */
  replaceAll: z.boolean().default(false),
  expectedYjsUpdatedAt: isoDateTimeSchema.optional(),
});
export type DocumentPatchRequest = z.infer<typeof documentPatchRequestSchema>;

/**
 * Writing under a heading (`POST /api/documents/:documentId/content/section`).
 *
 * The semantic layer over the block primitive: a section is addressed by the
 * heading a person would name it by, and `replace` swaps the *body* while the
 * heading stays, because the heading is the address. A heading that occurs
 * twice is refused with both identifiers, so the caller can say which one it
 * meant with `block` instead.
 */
export const documentSectionWriteRequestSchema = z.object({
  /** The heading's text, compared trimmed and without regard to case. */
  heading: z.string().min(1).max(300),
  markdown: z.string().max(200_000),
  mode: z.enum(['replace', 'append', 'prepend']).default('replace'),
  expectedYjsUpdatedAt: isoDateTimeSchema.optional(),
});
export type DocumentSectionWriteRequest = z.infer<typeof documentSectionWriteRequestSchema>;

/**
 * Moving a section onto a page of its own
 * (`POST /api/documents/:documentId/content/extract-section`, issue #118).
 *
 * The counterpart to reading a page as a map: the map hands out addresses, and
 * this takes one of them away. Splitting has to be cheaper than appending, or
 * appending wins -- today the same move is six calls that carry the whole page
 * through an agent's context twice, which is how pages grow until nothing can
 * read them.
 *
 * The address is the map's address: a heading brings its section along
 * (ADR-045), two identifiers mean the window between them, and the blocks that
 * move are the blocks that were named. What stays behind is the caller's
 * choice, because the three answers mean different things to a reader: a link
 * says the text moved, a transclusion shows it unchanged in its new home
 * (ADR-045), and `remove` says it is gone from here.
 */
export const extractSectionRequestSchema = z.object({
  /** The section's heading, or the first block of a window. */
  blockId: blockIdSchema,
  /** The last block, for a window. Omitted, a heading means its whole section. */
  toBlockId: blockIdSchema.optional(),
  /** Title of the new page. Without it, the heading names it. */
  title: z.string().min(1).max(300).optional(),
  /**
   * Where the new page goes. Omitted, it becomes a child of the page the
   * section came from, which is what "auf eine eigene Seite" almost always
   * means and keeps the section where a reader would look for it.
   */
  parentId: idSchema.optional(),
  /**
   * An existing page to append the section to instead of creating one. The
   * section lands at its end, and `title` and `parentId` are then unused.
   */
  targetDocumentId: idSchema.optional(),
  /** What stands in the section's place afterwards. */
  replacement: z.enum(['link', 'transclusion', 'remove']).default('link'),
  expectedYjsUpdatedAt: isoDateTimeSchema.optional(),
});
export type ExtractSectionRequest = z.infer<typeof extractSectionRequestSchema>;

export const extractSectionResponseSchema = z.object({
  /** The page the section now lives on, created or appended to. */
  document: documentSummarySchema,
  /** `true` when that page was created by this call. */
  created: z.boolean(),
  sourceDocumentId: idSchema,
  /** The heading the section was named by, `null` for a window of blocks. */
  heading: z.string().nullable(),
  movedBlocks: z.number().int().nonnegative(),
  movedChars: z.number().int().nonnegative(),
  replacement: z.enum(['link', 'transclusion', 'remove']),
  /** The source page's snapshot, to roll the whole move back with. */
  snapshotId: z.string(),
  yjsUpdatedAt: isoDateTimeSchema,
  appliedToLiveSession: z.boolean(),
  warnings: z.array(z.string()),
});
export type ExtractSectionResponse = z.infer<typeof extractSectionResponseSchema>;

/** What a narrow write answers with: the page write's response plus where it landed. */
export const documentGranularWriteResponseSchema = documentContentWriteResponseSchema.extend({
  /** Identifiers of the blocks that now stand where the edit landed. */
  blockIds: z.array(z.string()),
  /** Occurrences replaced. Always 1 except for a patch with `replaceAll`. */
  replacements: z.number().int().nonnegative(),
});
export type DocumentGranularWriteResponse = z.infer<typeof documentGranularWriteResponseSchema>;

export const aiRuleSummarySchema = z.object({
  documentId: idSchema,
  title: z.string(),
  mode: aiRuleModeSchema,
  trigger: z.string().nullable(),
  priority: z.number().int(),
});
export type AiRuleSummary = z.infer<typeof aiRuleSummarySchema>;

export const aiRuleListResponseSchema = z.object({ rules: z.array(aiRuleSummarySchema) });
export type AiRuleListResponse = z.infer<typeof aiRuleListResponseSchema>;

/**
 * Where a page belongs (issue: filing new pages into an existing structure).
 *
 * A caller that is about to create a page knows what the page is about and
 * nothing about the twelve sections it could go under. The suggestion is made
 * from the pages that already exist: the ones closest to this subject are
 * looked up, and the parents they sit under are ranked by how many of them
 * landed there. So the answer is a statement about the workspace's own filing
 * habits, not a model's opinion about taxonomy.
 *
 * Either `documentId` (file a page that exists) or `title` (file one that does
 * not exist yet) has to be given. Both together is allowed and useful: the
 * title of a page being renamed, or a draft title plus a summary.
 */
export const suggestParentRequestSchema = z
  .object({
    documentId: idSchema.optional(),
    title: z.string().trim().min(1).max(300).optional(),
    /** What the page is about, when it has no text yet. The first paragraph is plenty. */
    summary: z.string().trim().max(4000).optional(),
    limit: z.coerce.number().int().min(1).max(5).optional(),
  })
  .refine(
    (value) => value.documentId !== undefined || value.title !== undefined,
    'Either documentId or title is required',
  );
export type SuggestParentRequest = z.infer<typeof suggestParentRequestSchema>;

/** One candidate parent, with the evidence for it. */
export const parentSuggestionSchema = z.object({
  /** `null` is the workspace root: a top-level page is a legitimate answer. */
  parentId: idSchema.nullable(),
  title: z.string(),
  /** Ancestors of the candidate, root first. Empty for the root itself. */
  path: z.array(documentPathEntrySchema),
  /**
   * Relative strength, highest first. Comparable within one answer and
   * meaningless outside it, like `similarity` on a related document.
   */
  score: z.number(),
  /** How many active pages already sit under the candidate. */
  childCount: z.number().int().nonnegative(),
  /**
   * The neighbouring pages that put this candidate on the list. The reason is
   * shipped with the suggestion because "Creative & Media" alone is an
   * assertion, while "Fish Audio, HeyGen and MiniMax already live there" is an
   * argument a reader can check.
   */
  matches: z.array(z.object({ documentId: idSchema, title: z.string(), similarity: z.number() })),
});
export type ParentSuggestion = z.infer<typeof parentSuggestionSchema>;

export const suggestParentResponseSchema = z.object({
  /** The text the neighbours were looked up with, after title and summary were joined. */
  query: z.string(),
  /** Which search adapter answered, so a caller can tell semantic from full-text. */
  adapter: z.string(),
  suggestions: z.array(parentSuggestionSchema),
});
export type SuggestParentResponse = z.infer<typeof suggestParentResponseSchema>;
