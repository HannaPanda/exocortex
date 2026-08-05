import { z } from 'zod';

import {
  collaborationAccessSchema,
  documentIconSchema,
  documentTitleSchema,
  documentTypeSchema,
  idSchema,
  isoDateTimeSchema,
} from './primitives';

export const createDocumentRequestSchema = z.object({
  title: documentTitleSchema.default('Unbenannte Seite'),
  parentId: idSchema.nullable().optional(),
  type: documentTypeSchema.default('PAGE'),
  icon: documentIconSchema,
  /**
   * Optional sibling anchors. The server derives the fractional `orderKey`
   * itself; clients never send an order key.
   */
  afterSiblingId: idSchema.nullable().optional(),
  beforeSiblingId: idSchema.nullable().optional(),
});
export type CreateDocumentRequest = z.infer<typeof createDocumentRequestSchema>;

export const updateDocumentRequestSchema = z
  .object({
    title: documentTitleSchema.optional(),
    icon: documentIconSchema,
  })
  .refine((value) => value.title !== undefined || value.icon !== undefined, {
    message: 'At least one of "title" or "icon" must be provided',
  });
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
  reason: z.enum(['manual', 'scheduled', 'pre_restore', 'import', 'restore']),
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
