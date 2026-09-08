import {
  ENTITY_PROPERTY_NAMES,
  ENTITY_TYPE_LABELS,
  type EntityType,
  entityTypeSchema,
} from '@exocortex/contracts';
import { type EntityAliasCandidate, entityAliasKey, parseEntityAliases } from '@exocortex/editor';

import { type PrismaClient, type PrismaTransactionClient } from './client';

/**
 * Reading and writing the entity layer (issue #47).
 *
 * Lives here rather than in the API because the worker needs the identical
 * answer on the materialization path: an entity registry the extraction reads
 * over HTTP would mean one API round trip per saved page, and a second
 * implementation of "what are this row's aliases" would mean the profile and
 * the extraction could disagree about which names exist.
 *
 * Everything below reads the *rows of an ordinary ADR-011 database*. There is
 * no entity table, and adding one later would be a step backwards: the row is
 * what gives an entity a page, a body, references and a view a human prunes.
 */

/** One entity, as the matcher and the profile both need it. */
export interface EntityRecord {
  /** The row's document id. */
  id: string;
  workspaceId: string;
  title: string;
  type: EntityType;
  /** Every spelling except the title, which is always the first name tried. */
  aliases: string[];
  updatedAt: Date;
}

/** The German SELECT label back to the closed vocabulary clients can type. */
function typeFromLabel(label: string | null): EntityType {
  if (label === null) return 'other';
  for (const [type, name] of Object.entries(ENTITY_TYPE_LABELS)) {
    if (name.toLowerCase() === label.trim().toLowerCase()) {
      return entityTypeSchema.parse(type);
    }
  }
  // An option somebody added in the browser is not an error: the row is still
  // an entity, it just has a kind this deployment's clients cannot reason about.
  return 'other';
}

interface PropertyIds {
  type: string | null;
  aliases: string[];
}

/**
 * The two columns the layer reads, looked up by name.
 *
 * By name and not by id for the same reason the calendar mirror does it: a
 * person may delete and re-add a column, and an id stored in the settings would
 * quietly stop matching. `aliases` is a list because a `SELECT`-typed "Typ" and
 * a stray second "Aliasse" both have to be tolerated rather than crash a save.
 */
async function propertyIds(
  client: PrismaClient | PrismaTransactionClient,
  databaseId: string,
): Promise<PropertyIds> {
  const properties = await client.databaseProperty.findMany({
    where: { documentId: databaseId },
    select: { id: true, name: true, type: true },
  });
  return {
    type: properties.find((property) => property.name === ENTITY_PROPERTY_NAMES.type)?.id ?? null,
    aliases: properties
      .filter((property) => property.name === ENTITY_PROPERTY_NAMES.aliases)
      .map((property) => property.id),
  };
}

/**
 * Every entity in the database, with its aliases resolved.
 *
 * Loaded whole rather than queried per page, because the matcher needs all of
 * them for every page anyway and the list is small by construction: an entity
 * list large enough for this to hurt is a list nobody is curating, which is the
 * failure the threshold exists to prevent.
 */
export async function loadEntityRegistry(
  client: PrismaClient | PrismaTransactionClient,
  databaseId: string,
): Promise<EntityRecord[]> {
  const ids = await propertyIds(client, databaseId);
  const rows = await client.document.findMany({
    where: { parentId: databaseId, type: 'PAGE', archivedAt: null },
    select: {
      id: true,
      workspaceId: true,
      title: true,
      updatedAt: true,
      propertyValues: {
        where: {
          propertyId: { in: [...(ids.type === null ? [] : [ids.type]), ...ids.aliases] },
        },
        select: { propertyId: true, textValue: true },
      },
    },
    orderBy: { title: 'asc' },
  });

  const optionLabels = await selectOptionLabels(client, ids.type);

  return rows.map((row) => {
    const typeValue = row.propertyValues.find((value) => value.propertyId === ids.type);
    const aliasText = row.propertyValues
      .filter((value) => ids.aliases.includes(value.propertyId))
      .map((value) => value.textValue ?? '')
      .join(', ');
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      // A SELECT stores the *option id* in `textValue`, never the label.
      type: typeFromLabel(optionLabels.get(typeValue?.textValue ?? '') ?? null),
      aliases: parseEntityAliases(aliasText).filter(
        (alias) => entityAliasKey(alias) !== entityAliasKey(row.title),
      ),
      updatedAt: row.updatedAt,
    };
  });
}

async function selectOptionLabels(
  client: PrismaClient | PrismaTransactionClient,
  propertyId: string | null,
): Promise<Map<string, string>> {
  if (propertyId === null) return new Map();
  const options = await client.databasePropertyOption.findMany({
    where: { propertyId },
    select: { id: true, label: true },
  });
  return new Map(options.map((option) => [option.id, option.label]));
}

/** The registry flattened into what the matcher takes: one row per spelling. */
export function toAliasCandidates(entities: readonly EntityRecord[]): EntityAliasCandidate[] {
  return entities.flatMap((entity) => [
    { entityId: entity.id, alias: entity.title },
    ...entity.aliases.map((alias) => ({ entityId: entity.id, alias })),
  ]);
}

/** Every name the registry answers to, normalized. What a candidate is checked against. */
export function knownAliasKeys(entities: readonly EntityRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const entity of entities) {
    keys.add(entityAliasKey(entity.title));
    for (const alias of entity.aliases) keys.add(entityAliasKey(alias));
  }
  return keys;
}

export interface EntityMentionInput {
  entityDocumentId: string;
  alias: string;
  aliasKey: string;
  occurrences: number;
  context: string;
}

/**
 * Replaces what one page says about entities.
 *
 * Extracted edges are wholesale-replaced, manual ones are left alone: the pass
 * owns what it wrote and nothing else. `firstSeenAt` survives an update, so
 * "this page has talked about the host since March" stays true across every
 * edit in between.
 */
export async function replaceEntityMentions(
  client: PrismaClient,
  input: {
    documentId: string;
    workspaceId: string;
    mentions: readonly EntityMentionInput[];
  },
): Promise<number> {
  const keep = new Set(input.mentions.map((mention) => mention.entityDocumentId));
  const now = new Date();

  return client.$transaction(async (tx) => {
    await tx.entityMention.deleteMany({
      where: {
        documentId: input.documentId,
        source: 'EXTRACTED',
        ...(keep.size === 0 ? {} : { entityDocumentId: { notIn: [...keep] } }),
      },
    });

    let written = 0;
    for (const mention of input.mentions) {
      const result = await tx.entityMention.upsert({
        where: {
          entityDocumentId_documentId: {
            entityDocumentId: mention.entityDocumentId,
            documentId: input.documentId,
          },
        },
        create: {
          entityDocumentId: mention.entityDocumentId,
          documentId: input.documentId,
          workspaceId: input.workspaceId,
          alias: mention.alias,
          aliasKey: mention.aliasKey,
          occurrences: mention.occurrences,
          context: mention.context,
          source: 'EXTRACTED',
          firstSeenAt: now,
          lastSeenAt: now,
        },
        // A manual edge keeps its note and its source; the pass only refreshes
        // how often the name appears, which is information either way.
        update: {
          occurrences: mention.occurrences,
          lastSeenAt: now,
        },
        select: { source: true },
      });
      if (result.source === 'EXTRACTED') written += 1;
    }
    return written;
  });
}

export interface EntityPhraseInput {
  phrase: string;
  phraseKey: string;
  occurrences: number;
  context: string;
}

/**
 * Records what this page saw of names that are not entities yet.
 *
 * Sightings for the page are replaced, never added to, so a page edited twenty
 * times counts once. A candidate whose last sighting disappears is left behind
 * deliberately: it may still be dismissed, and a dismissal that vanishes when
 * somebody edits a page is a suggestion that comes back from the dead.
 */
export async function replaceEntityCandidateSightings(
  client: PrismaClient,
  input: {
    documentId: string;
    workspaceId: string;
    phrases: readonly EntityPhraseInput[];
  },
): Promise<number> {
  const now = new Date();
  return client.$transaction(async (tx) => {
    await tx.entityCandidateSighting.deleteMany({ where: { documentId: input.documentId } });
    for (const phrase of input.phrases) {
      const candidate = await tx.entityCandidate.upsert({
        where: { phraseKey: phrase.phraseKey },
        create: { phrase: phrase.phrase, phraseKey: phrase.phraseKey },
        update: { phrase: phrase.phrase, lastSeenAt: now },
        select: { id: true, dismissedAt: true, promotedDocumentId: true },
      });
      // A phrase somebody threw away, or that has already become an entity,
      // needs no further evidence collected about it.
      if (candidate.dismissedAt !== null || candidate.promotedDocumentId !== null) continue;
      await tx.entityCandidateSighting.create({
        data: {
          candidateId: candidate.id,
          documentId: input.documentId,
          workspaceId: input.workspaceId,
          occurrences: phrase.occurrences,
          context: phrase.context,
          seenAt: now,
        },
      });
    }
    return input.phrases.length;
  });
}
