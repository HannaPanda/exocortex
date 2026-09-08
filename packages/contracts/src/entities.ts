import { z } from 'zod';

import { documentPathEntrySchema } from './documents';
import { idSchema, isoDateTimeSchema } from './primitives';

/**
 * The entity layer (issue #47).
 *
 * Everything the system knows about the world is prose in pages. That is fine
 * for a person, who reads the page and understands it, and expensive for an
 * agent, which has to load five pages to answer "what do we know about fpb2".
 * An entity is the handle that question needs: a name with its aliases, and the
 * edges from it to every page that talks about it.
 *
 * An entity is *not* a new model. It is a row in an ordinary ADR-011 database,
 * which is what gives it a title, a body, properties, references, a place in
 * the tree and a view a human can sort and prune, without a line of new
 * rendering. These schemas describe the two things a row cannot carry: the
 * edges, and the evidence for a name that is not a row yet.
 */

/**
 * What kind of thing an entity is.
 *
 * A closed set on purpose. The type is stored as a SELECT option on the row, so
 * a person can add an option in the browser at any time, but a client that
 * wants to reason about entities needs a vocabulary it can type; `other` is the
 * honest bucket for everything the list does not name.
 */
export const entityTypeSchema = z.enum([
  'person',
  'host',
  'service',
  'project',
  'credential',
  'organisation',
  'other',
]);
export type EntityType = z.infer<typeof entityTypeSchema>;

/** The German label each type carries as a SELECT option on the row. */
export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  person: 'Person',
  host: 'Host',
  service: 'Dienst',
  project: 'Projekt',
  credential: 'Zugang',
  organisation: 'Organisation',
  other: 'Sonstiges',
};

/** Names the properties of the entity database carry. Matched by name, never by id. */
export const ENTITY_PROPERTY_NAMES = {
  type: 'Typ',
  aliases: 'Aliasse',
} as const;

export const entitySummarySchema = z.object({
  /** The row's document id. An entity *is* its page. */
  id: idSchema,
  workspaceId: idSchema,
  /** The canonical name. Always an alias of itself. */
  title: z.string(),
  type: entityTypeSchema,
  /** Every other spelling the matcher answers to, canonical name excluded. */
  aliases: z.array(z.string()),
  /** Pages that talk about it, as far as the caller may see them. */
  mentionCount: z.number().int().nonnegative(),
  updatedAt: isoDateTimeSchema,
});
export type EntitySummary = z.infer<typeof entitySummarySchema>;

export const entityListQuerySchema = z.object({
  /** Substring of a name or an alias. Omitted lists everything. */
  q: z.string().trim().min(1).max(200).optional(),
  type: entityTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type EntityListQuery = z.infer<typeof entityListQuerySchema>;

export const entityListResponseSchema = z.object({
  /** The configured entity database, or null when the deployment has none. */
  databaseId: idSchema.nullable(),
  entities: z.array(entitySummarySchema),
});
export type EntityListResponse = z.infer<typeof entityListResponseSchema>;

/** One page that talks about the entity. */
export const entityMentionSchema = z.object({
  documentId: idSchema,
  workspaceId: idSchema,
  workspaceName: z.string(),
  title: z.string(),
  path: z.array(documentPathEntrySchema),
  /** The alias this page uses. Which name a page picks is itself information. */
  alias: z.string(),
  occurrences: z.number().int().positive(),
  /** The sentence around the first occurrence. */
  context: z.string(),
  /** `manual` means a person or an agent drew this edge; the pass leaves it alone. */
  source: z.enum(['extracted', 'manual']),
  lastSeenAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type EntityMention = z.infer<typeof entityMentionSchema>;

/**
 * Another entity this one is connected to.
 *
 * Connections between entities are ordinary references between their pages
 * (issue #33), not a new property type: writing `[[fpb2]]` on the Orielle page
 * is how a human already says "runs on", and building a second, parallel notion
 * of a relation would mean two answers to the same question.
 */
export const entityRelationSchema = z.object({
  id: idSchema,
  title: z.string(),
  type: entityTypeSchema,
  /** `outgoing` when this entity's page names the other one. */
  direction: z.enum(['outgoing', 'incoming']),
});
export type EntityRelation = z.infer<typeof entityRelationSchema>;

/**
 * The answer to "what do we know about X", in one request.
 *
 * Three layers, deliberately in this order: what the memory holds to be *true*
 * (issue #46), what the entity is connected to, and only then the pages to read.
 * Without the facts a profile is a link list; with them it is a statement.
 */
export const entityProfileSchema = z.object({
  entity: entitySummarySchema,
  /** The opening lines of the entity's own page, capped. Empty when it has none. */
  summary: z.string(),
  /** Distilled facts naming this entity, best first. Empty without consolidation. */
  facts: z.array(
    z.object({
      id: idSchema,
      documentId: idSchema,
      statement: z.string(),
      confirmations: z.number().int().nonnegative(),
      lastConfirmedAt: isoDateTimeSchema,
    }),
  ),
  relations: z.array(entityRelationSchema),
  /** Pages that talk about it, most recently changed first. */
  mentions: z.array(entityMentionSchema),
  /** Mentions in workspaces the caller may not read. A count, never a title. */
  hiddenMentions: z.number().int().nonnegative(),
  /** The whole profile as one block of German text, for a prompt. */
  text: z.string(),
});
export type EntityProfile = z.infer<typeof entityProfileSchema>;

const aliasListSchema = z
  .array(z.string().trim().min(2).max(120))
  .max(20)
  .default([])
  /** Two spellings that normalize to the same thing are one alias. */
  .transform((aliases) => [...new Set(aliases)]);

export const createEntityRequestSchema = z.object({
  title: z.string().trim().min(2).max(200),
  type: entityTypeSchema.default('other'),
  aliases: aliasListSchema,
  /** Markdown for the entity's page. Optional: a name alone is already useful. */
  summary: z.string().trim().max(20_000).default(''),
});
export type CreateEntityRequest = z.infer<typeof createEntityRequestSchema>;

export const updateEntityRequestSchema = z
  .object({
    type: entityTypeSchema.optional(),
    aliases: aliasListSchema.optional(),
  })
  .refine((value) => value.type !== undefined || value.aliases !== undefined, {
    message: 'Nothing to update',
  });
export type UpdateEntityRequest = z.infer<typeof updateEntityRequestSchema>;

/**
 * Draws the edge by hand.
 *
 * The pass matches names; a page can be about an entity without ever spelling
 * it out, and no amount of matching will find that. A manual edge survives
 * every re-extraction for the same reason.
 */
export const linkEntityPageRequestSchema = z.object({
  documentId: idSchema,
  /** Why this page belongs to the entity. Shown where an extracted context is. */
  note: z.string().trim().max(500).default(''),
});
export type LinkEntityPageRequest = z.infer<typeof linkEntityPageRequestSchema>;

export const entityMutationResponseSchema = z.object({
  entity: entitySummarySchema,
  /** Pages the alias change reached, when the change triggered a rescan. */
  rescanQueued: z.boolean().default(false),
});
export type EntityMutationResponse = z.infer<typeof entityMutationResponseSchema>;

/** A name that keeps turning up and that no entity answers to yet. */
export const entityCandidateSchema = z.object({
  id: idSchema,
  phrase: z.string(),
  /** Separate pages it was seen on. The number the threshold is about. */
  documentCount: z.number().int().nonnegative(),
  occurrences: z.number().int().nonnegative(),
  firstSeenAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  /** A few pages it appeared on, for judging it without opening anything. */
  samples: z.array(
    z.object({
      documentId: idSchema,
      title: z.string(),
      context: z.string(),
    }),
  ),
});
export type EntityCandidate = z.infer<typeof entityCandidateSchema>;

export const entityCandidateListQuerySchema = z.object({
  /**
   * Pages a phrase must appear on before it is worth showing. Defaults to the
   * deployment's threshold; a caller may raise it, never lower it below one.
   */
  minDocuments: z.coerce.number().int().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type EntityCandidateListQuery = z.infer<typeof entityCandidateListQuerySchema>;

export const entityCandidateListResponseSchema = z.object({
  threshold: z.number().int().positive(),
  candidates: z.array(entityCandidateSchema),
});
export type EntityCandidateListResponse = z.infer<typeof entityCandidateListResponseSchema>;

export const confirmEntityCandidateRequestSchema = z.object({
  /** The canonical name. Defaults to the phrase as seen. */
  title: z.string().trim().min(2).max(200).optional(),
  type: entityTypeSchema.default('other'),
  /** Further spellings. The phrase itself is always one, and need not be listed. */
  aliases: aliasListSchema,
});
export type ConfirmEntityCandidateRequest = z.infer<typeof confirmEntityCandidateRequestSchema>;

export const confirmEntityCandidateResponseSchema = z.object({
  entity: entitySummarySchema,
  /** Pages that already carried the phrase and became mentions right away. */
  adoptedMentions: z.number().int().nonnegative(),
});
export type ConfirmEntityCandidateResponse = z.infer<typeof confirmEntityCandidateResponseSchema>;

export const dismissEntityCandidateResponseSchema = z.object({
  id: idSchema,
  phrase: z.string(),
  dismissedAt: isoDateTimeSchema,
});
export type DismissEntityCandidateResponse = z.infer<typeof dismissEntityCandidateResponseSchema>;

/**
 * Creates the entity database and points the deployment at it.
 *
 * Separate from `POST /api/documents` with a `COLLECTION` type because the
 * database is only useful with the two columns the matcher reads, and because
 * naming it in the settings is the half a person forgets.
 */
export const provisionEntityDatabaseRequestSchema = z.object({
  workspaceId: idSchema,
  /** Page to hang it under. Null puts it at the workspace root. */
  parentId: idSchema.nullable().default(null),
  title: z.string().trim().min(1).max(200).default('Entitäten'),
});
export type ProvisionEntityDatabaseRequest = z.infer<typeof provisionEntityDatabaseRequestSchema>;

export const provisionEntityDatabaseResponseSchema = z.object({
  databaseId: idSchema,
  workspaceId: idSchema,
  title: z.string(),
  /** True when the deployment already had one and this returned it unchanged. */
  alreadyExisted: z.boolean(),
});
export type ProvisionEntityDatabaseResponse = z.infer<typeof provisionEntityDatabaseResponseSchema>;
