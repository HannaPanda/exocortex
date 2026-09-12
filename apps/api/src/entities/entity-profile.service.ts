import { Inject, Injectable } from '@nestjs/common';

import {
  type EntityMention,
  type EntityProfile,
  type EntityRelation,
  type EntitySummary,
} from '@exocortex/contracts';
import { type EntityRecord, type PrismaClient } from '@exocortex/database';
import { entityAliasKey } from '@exocortex/editor';

import { memoryWorkspacesAmong } from '../memory/memory-workspace';
import { PRISMA } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import { EntityRegistryService } from './entity-registry.service';

/** Pages named in one profile. Beyond this the answer stops being an answer. */
const MAX_MENTIONS = 25;
/** Distilled facts a profile carries. */
const MAX_FACTS = 8;
/** Characters of the entity's own page the profile quotes. */
const MAX_SUMMARY_CHARS = 600;
/** Characters of the rendered text block. Bounds what a recall may paste. */
const MAX_TEXT_CHARS = 2_500;

/**
 * "What do I know about X", in one request (issue #47).
 *
 * The order of the three layers is the whole point. A person asking this reads
 * the pages; an agent with a context window cannot afford to, and needs the
 * answer rather than the reading list. So: what the memory holds to be true
 * (issue #46) first, what the entity is connected to second, the pages last.
 * Without the facts a profile is a link list, which is what the search box
 * already gives.
 */
@Injectable()
export class EntityProfileService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly registry: EntityRegistryService,
    private readonly settings: SettingsService,
  ) {}

  async profile(userId: string, entityId: string): Promise<EntityProfile> {
    const entity = await this.registry.findReadable(userId, entityId);
    const readable = await this.registry.readableWorkspaceIds(userId);
    const counts = await this.registry.mentionCounts([entity.id], readable);
    const summary = this.registry.toSummary(entity, counts.get(entity.id) ?? 0);

    const [page, mentions, hidden, relations, facts] = await Promise.all([
      this.ownPage(entity.id),
      this.mentions(entity.id, readable),
      this.hiddenMentions(entity.id, readable),
      this.relations(entity, userId),
      this.facts(entity, readable),
    ]);

    return {
      entity: summary,
      summary: page,
      facts,
      relations,
      mentions,
      hiddenMentions: hidden,
      text: renderProfile({ entity: summary, summary: page, facts, relations, mentions }),
    };
  }

  /** The opening lines of the entity's own page. What a person wrote about it. */
  private async ownPage(entityId: string): Promise<string> {
    const content = await this.prisma.documentContent.findUnique({
      where: { documentId: entityId },
      select: { plainText: true },
    });
    const text = (content?.plainText ?? '').trim();
    return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS)}…`;
  }

  private async mentions(
    entityId: string,
    readable: ReadonlySet<string>,
  ): Promise<EntityMention[]> {
    if (readable.size === 0) return [];
    const rows = await this.prisma.entityMention.findMany({
      where: {
        entityDocumentId: entityId,
        workspaceId: { in: [...readable] },
        document: { archivedAt: null },
      },
      // By the page's own recency, not by the edge's: the question is "what has
      // been said about this lately", and an edge is refreshed by every save.
      orderBy: { document: { updatedAt: 'desc' } },
      take: MAX_MENTIONS,
      select: {
        documentId: true,
        workspaceId: true,
        alias: true,
        occurrences: true,
        context: true,
        source: true,
        lastSeenAt: true,
        document: {
          select: {
            title: true,
            updatedAt: true,
            parentId: true,
            workspace: { select: { name: true } },
          },
        },
      },
    });

    const parents = await this.parentTitles(rows.map((row) => row.document.parentId));

    return rows.map((row) => ({
      documentId: row.documentId,
      workspaceId: row.workspaceId,
      workspaceName: row.document.workspace.name,
      title: row.document.title,
      path:
        row.document.parentId === null
          ? []
          : [
              {
                id: row.document.parentId,
                title: parents.get(row.document.parentId) ?? '',
              },
            ],
      alias: row.alias,
      occurrences: row.occurrences,
      context: row.context,
      source: row.source === 'MANUAL' ? ('manual' as const) : ('extracted' as const),
      lastSeenAt: row.lastSeenAt.toISOString(),
      updatedAt: row.document.updatedAt.toISOString(),
    }));
  }

  private async parentTitles(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();
    const parents = await this.prisma.document.findMany({
      where: { id: { in: wanted } },
      select: { id: true, title: true },
    });
    return new Map(parents.map((parent) => [parent.id, parent.title]));
  }

  /**
   * Pages in workspaces the caller may not read.
   *
   * A number and never a title. That the entity is talked about elsewhere is
   * worth knowing; where, and under what heading, is exactly what the
   * membership check exists to withhold.
   */
  private async hiddenMentions(entityId: string, readable: ReadonlySet<string>): Promise<number> {
    return this.prisma.entityMention.count({
      where: {
        entityDocumentId: entityId,
        document: { archivedAt: null },
        ...(readable.size === 0 ? {} : { workspaceId: { notIn: [...readable] } }),
      },
    });
  }

  /**
   * Other entities this one is connected to.
   *
   * Read off the ordinary reference index (issue #33), not off a relation
   * column: writing `[[fpb2]]` on the Orielle page is how a person already says
   * "runs on", and a second, parallel notion of a relation would mean two
   * answers to the same question and one of them going stale.
   */
  private async relations(entity: EntityRecord, userId: string): Promise<EntityRelation[]> {
    const registry = await this.registry.loadReadable(userId);
    const byId = new Map(registry.map((record) => [record.id, record]));

    const [outgoing, incoming] = await Promise.all([
      this.prisma.documentLink.findMany({
        where: { sourceDocumentId: entity.id, targetDocumentId: { not: null } },
        select: { targetDocumentId: true },
      }),
      this.prisma.documentLink.findMany({
        where: { targetDocumentId: entity.id },
        select: { sourceDocumentId: true },
      }),
    ]);

    const relations = new Map<string, EntityRelation>();
    for (const link of outgoing) {
      const other = byId.get(link.targetDocumentId ?? '');
      if (other === undefined || other.id === entity.id) continue;
      relations.set(other.id, {
        id: other.id,
        title: other.title,
        type: other.type,
        direction: 'outgoing',
      });
    }
    for (const link of incoming) {
      const other = byId.get(link.sourceDocumentId);
      if (other === undefined || other.id === entity.id || relations.has(other.id)) continue;
      relations.set(other.id, {
        id: other.id,
        title: other.title,
        type: other.type,
        direction: 'incoming',
      });
    }
    return [...relations.values()];
  }

  /**
   * Distilled facts naming this entity (issue #46).
   *
   * Matched against the statement, which is the fact page's title, by plain
   * containment of a name. A fact is one line by construction, so a name in it
   * is the fact being about the entity rather than a passing reference; the
   * cheap check is the right check here.
   */
  private async facts(
    entity: EntityRecord,
    readable: ReadonlySet<string>,
  ): Promise<EntityProfile['facts']> {
    // Every memory area the caller may read, not one configured id (issue #52):
    // a profile should carry what this account knows, wherever it wrote it down.
    const workspaceIds = await memoryWorkspacesAmong(this.prisma, [...readable]);
    if (workspaceIds.length === 0) return [];

    const names = [entity.title, ...entity.aliases];
    const rows = await this.prisma.memoryFact.findMany({
      where: {
        workspaceId: { in: workspaceIds },
        status: 'CURRENT',
        document: {
          archivedAt: null,
          OR: names.map((name) => ({ title: { contains: name, mode: 'insensitive' as const } })),
        },
      },
      orderBy: [{ confidence: 'desc' }, { lastConfirmedAt: 'desc' }],
      take: MAX_FACTS,
      select: {
        id: true,
        documentId: true,
        confirmations: true,
        lastConfirmedAt: true,
        document: { select: { title: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      documentId: row.documentId,
      statement: row.document.title,
      confirmations: row.confirmations,
      lastConfirmedAt: row.lastConfirmedAt.toISOString(),
    }));
  }
}

/**
 * The profile as one block of German text.
 *
 * Rendered here rather than by each client for the same reason `recall` renders
 * its own: the hook that pastes this into a session start has no formatting
 * logic and should need none, and two clients formatting the same answer
 * differently is how a prompt regression becomes untraceable.
 */
export function renderProfile(input: {
  entity: EntitySummary;
  summary: string;
  facts: EntityProfile['facts'];
  relations: readonly EntityRelation[];
  mentions: readonly EntityMention[];
}): string {
  const lines: string[] = [`## ${input.entity.title}`];
  const aliases = input.entity.aliases;
  if (aliases.length > 0) lines.push(`Auch: ${aliases.join(', ')}`);
  if (input.summary.length > 0) lines.push('', input.summary);

  if (input.facts.length > 0) {
    lines.push('', 'Was gilt:');
    for (const fact of input.facts) {
      lines.push(`- ${fact.statement} (${fact.confirmations}× bestätigt)`);
    }
  }

  if (input.relations.length > 0) {
    lines.push('', 'Hängt zusammen mit:');
    for (const relation of input.relations) {
      lines.push(`- ${relation.title}`);
    }
  }

  if (input.mentions.length > 0) {
    lines.push('', 'Seiten dazu:');
    for (const mention of input.mentions) {
      lines.push(`- ${mention.title}: ${mention.context}`);
    }
  }

  const text = lines.join('\n');
  return text.length <= MAX_TEXT_CHARS ? text : `${text.slice(0, MAX_TEXT_CHARS)}…`;
}

/** True when the text names this entity. Used by the recall hook. */
export function textNamesEntity(text: string, entity: EntityRecord): boolean {
  const key = entityAliasKey(text);
  return [entity.title, ...entity.aliases].some((name) => {
    const alias = entityAliasKey(name);
    if (alias.length < 3) return false;
    return key === alias || key.includes(alias);
  });
}
