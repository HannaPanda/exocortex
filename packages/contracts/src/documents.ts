import { z } from 'zod';

import {
  collaborationAccessSchema,
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

const updateDocumentFieldsSchema = z.object({
  title: documentTitleSchema.optional(),
  icon: documentIconSchema,
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
});
export type MoveDocumentRequest = z.infer<typeof moveDocumentRequestSchema>;

export const documentSummarySchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  parentId: idSchema.nullable(),
  type: documentTypeSchema,
  title: z.string(),
  icon: z.string().nullable(),
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

export const documentDetailSchema = documentSummarySchema.extend({
  /** Access level the requesting user has for this document. */
  access: collaborationAccessSchema,
  breadcrumb: z.array(z.object({ id: idSchema, title: z.string(), icon: z.string().nullable() })),
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
