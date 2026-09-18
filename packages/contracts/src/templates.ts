import { z } from 'zod';

import { documentSummarySchema } from './documents';
import { documentTitleSchema, idSchema, isoDateTimeSchema } from './primitives';

/**
 * Page templates (issue #79, ADR-039).
 *
 * Not to be confused with the render templates of issue #44: those turn a page
 * into a PDF, these turn nothing into a page. A template here is an ordinary
 * page that has been marked as one, and using it copies its content into a new
 * page that keeps no link back. Everything in this file therefore names a
 * `documentId`: there is no template id, because there is no template object
 * apart from the page.
 */

export const documentTemplateSchema = z.object({
  /** The template page itself. Its title and icon are what the picker shows. */
  document: documentSummarySchema,
  /** One line on when to reach for this template. */
  description: z.string().nullable(),
  /** Pattern the copy's title is built from; null names the copy after the template. */
  titlePattern: z.string().nullable(),
  /** Where a copy lands when the caller names no parent; null means the root. */
  targetParent: documentSummarySchema.nullable(),
  useCount: z.number().int().nonnegative(),
  lastUsedAt: isoDateTimeSchema.nullable(),
});
export type DocumentTemplate = z.infer<typeof documentTemplateSchema>;

export const templateResponseSchema = z.object({ template: documentTemplateSchema });
export type TemplateResponse = z.infer<typeof templateResponseSchema>;

export const deleteTemplateResponseSchema = z.object({ deleted: z.literal(true) });
export type DeleteTemplateResponse = z.infer<typeof deleteTemplateResponseSchema>;

export const templateListResponseSchema = z.object({
  /** Recently used first, then the ones never used, alphabetically. */
  templates: z.array(documentTemplateSchema),
});
export type TemplateListResponse = z.infer<typeof templateListResponseSchema>;

/**
 * The fields a template carries beside its page. Shared by create and update
 * so the two cannot drift; on update every one of them is optional, and `null`
 * clears rather than keeps.
 */
const templateFieldsSchema = z.object({
  description: z.string().trim().max(500).nullable().optional(),
  titlePattern: z.string().trim().max(200).nullable().optional(),
  targetParentId: idSchema.nullable().optional(),
});

export const createTemplateRequestSchema = templateFieldsSchema.extend({
  /**
   * The page that becomes a template. It stays exactly where it is: marking a
   * page is not a move, and a workspace that wants its templates in one place
   * makes a page for them like it would for anything else.
   */
  documentId: idSchema,
});
export type CreateTemplateRequest = z.infer<typeof createTemplateRequestSchema>;

export const updateTemplateRequestSchema = templateFieldsSchema;
export type UpdateTemplateRequest = z.infer<typeof updateTemplateRequestSchema>;

export const instantiateTemplateRequestSchema = z.object({
  /**
   * What the page is called, in place of the template's own title. The
   * pattern still applies and this is what `{{titel}}` stands for in it, so a
   * template patterned `Notiz {{titel}}` and a title of `Bahn` produce
   * `Notiz Bahn`.
   */
  title: documentTitleSchema.optional(),
  /**
   * Where the copy goes. Left out, the template's suggested target is used,
   * and the workspace root when it has none.
   */
  parentId: idSchema.nullable().optional(),
  afterSiblingId: idSchema.optional(),
  beforeSiblingId: idSchema.optional(),
});
export type InstantiateTemplateRequest = z.infer<typeof instantiateTemplateRequestSchema>;

export const instantiateTemplateResponseSchema = z.object({
  /** The new page. An ordinary page: nothing about it points back here. */
  document: documentSummarySchema,
  /** Where it landed, or null at the workspace root. */
  parent: documentSummarySchema.nullable(),
  /** How many database properties were carried over, 0 when there are none. */
  copiedProperties: z.number().int().nonnegative(),
  /** What could not be copied exactly, in German, for the person who asked. */
  warnings: z.array(z.string()),
});
export type InstantiateTemplateResponse = z.infer<typeof instantiateTemplateResponseSchema>;
