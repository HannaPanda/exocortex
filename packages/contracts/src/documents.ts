import { z } from 'zod';

import {
  collaborationAccessSchema,
  DOCUMENT_ICON_COLORS,
  documentIconColorSchema,
  documentIconSchema,
  documentTitleSchema,
  documentTypeSchema,
  idSchema,
  isoDateTimeSchema,
} from './primitives';

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
  type: documentTypeSchema.default('PAGE'),
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
    value.aiRulePriority !== undefined,
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

export const documentTreeResponseSchema = z.object({
  nodes: z.array(documentTreeNodeSchema),
  /** Archived documents are returned flat so the trash view can list them. */
  archived: z.array(documentSummarySchema),
});
export type DocumentTreeResponse = z.infer<typeof documentTreeResponseSchema>;

/**
 * Resolves a reference to another page to the document(s) it means.
 *
 * Two ways in, and they are tried in that order: `documentId`, the identity a
 * `pageLink` block stores, and `title`, which is what `[[Titel]]` /
 * `wiki:Titel` and a page mention carry. Identity first is what makes renaming
 * a page harmless; the title is the fallback that keeps a reference alive when
 * its target was deleted and written again.
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
  filename: z.string(),
  markdown: z.string(),
});
export type MarkdownExportResponse = z.infer<typeof markdownExportResponseSchema>;

export const markdownImportRequestSchema = z.object({
  markdown: z.string().min(1).max(2_000_000),
  parentId: idSchema.nullable().optional(),
  /** Falls back to the frontmatter title, then to the first heading. */
  title: documentTitleSchema.optional(),
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
