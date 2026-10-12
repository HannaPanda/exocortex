import { z } from 'zod';

import {
  DOCUMENT_ICON_COLORS,
  documentTypeSchema,
  idSchema,
  isoDateTimeSchema,
} from './primitives';

/**
 * The knowledge map: every page of a workspace as a point, and every kind of
 * connection between two pages as a line (issue #189).
 *
 * It is a read model and stores nothing. The references come from the index
 * the materialization job keeps, the similarities from the vectors the search
 * already holds, the entities from the entity layer and the hierarchy from the
 * tree; the map only puts them side by side. A node carries enough to draw and
 * to label a point, never the page's text.
 */

/**
 * What a point stands for. Every point is a document; an `entity` is a row of
 * the entity database (a person, a place, a project the pages mention), which
 * the map draws differently because it is a subject rather than a note.
 */
export const knowledgeMapNodeKindSchema = z.enum(['page', 'entity']);
export type KnowledgeMapNodeKind = z.infer<typeof knowledgeMapNodeKindSchema>;

/**
 * What a line says.
 *
 * - `link`: one page references the other (`[[…]]`, a mention, a page link).
 * - `similar`: the two pages are close in meaning without either naming the
 *   other. Derived from the search vectors, so absent where search has none.
 * - `entity`: a page is linked to an entity of the entity layer.
 * - `tree`: a page hangs under the other one.
 *
 * A transclusion is not a kind of its own: it lives only in the page content
 * and no index holds it, so drawing it would mean parsing every page per read.
 */
export const knowledgeMapEdgeKindSchema = z.enum(['link', 'similar', 'entity', 'tree']);
export type KnowledgeMapEdgeKind = z.infer<typeof knowledgeMapEdgeKindSchema>;

export const knowledgeMapNodeSchema = z.object({
  id: idSchema,
  kind: knowledgeMapNodeKindSchema,
  title: z.string(),
  type: documentTypeSchema,
  icon: z.string().nullable(),
  iconColor: z.enum(DOCUMENT_ICON_COLORS).nullable(),
  /** The page this one hangs under; `null` at top level. */
  parentId: idSchema.nullable(),
  /**
   * The top-level page of the branch the point belongs to. It is what colours
   * a region of the map, so a branch reads as one cloud. Its own id at top level.
   */
  rootId: idSchema,
  /** Number of lines of every kind ending here; the map sizes a point by it. */
  degree: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  /** The later of the row's own change and the last write to the body. */
  editedAt: isoDateTimeSchema,
});
export type KnowledgeMapNode = z.infer<typeof knowledgeMapNodeSchema>;

export const knowledgeMapEdgeSchema = z.object({
  source: idSchema,
  target: idSchema,
  kind: knowledgeMapEdgeKindSchema,
  /**
   * How strong the connection is, between 0 and 1. A similarity carries its
   * cosine, a reference counts how often it is made (capped), the rest are 1.
   */
  weight: z.number().min(0).max(1),
});
export type KnowledgeMapEdge = z.infer<typeof knowledgeMapEdgeSchema>;

/**
 * Whether the similarity lines are in the answer: `ok` they are, `disabled`
 * this deployment has no semantic search, `partial` some pages have no vector
 * yet and appear without similarity lines.
 */
export const knowledgeMapSemanticStateSchema = z.enum(['ok', 'partial', 'disabled']);
export type KnowledgeMapSemanticState = z.infer<typeof knowledgeMapSemanticStateSchema>;

export const knowledgeMapQuerySchema = z.object({
  /** Leave lines of these kinds out. Comma separated, e.g. `tree,similar`. */
  exclude: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === '' ? [] : value.split(',').map((part) => part.trim()),
    )
    .pipe(z.array(knowledgeMapEdgeKindSchema)),
});
export type KnowledgeMapQuery = z.infer<typeof knowledgeMapQuerySchema>;

export const knowledgeMapResponseSchema = z.object({
  workspaceId: idSchema,
  generatedAt: isoDateTimeSchema,
  semantic: knowledgeMapSemanticStateSchema,
  nodes: z.array(knowledgeMapNodeSchema),
  edges: z.array(knowledgeMapEdgeSchema),
});
export type KnowledgeMapResponse = z.infer<typeof knowledgeMapResponseSchema>;
