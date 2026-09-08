import { Inject, Injectable } from '@nestjs/common';

import {
  type ConfirmEntityCandidateRequest,
  type ConfirmEntityCandidateResponse,
  type DismissEntityCandidateResponse,
  type EntityCandidate,
  type EntityCandidateListQuery,
  type EntityCandidateListResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import { EntitiesService } from './entities.service';
import { EntityRegistryService } from './entity-registry.service';

/** Sample pages shown per candidate. Enough to judge it, not enough to read. */
const MAX_SAMPLES = 3;

/**
 * Names that keep turning up and that no entity answers to yet (issue #47).
 *
 * The reason the extraction does not simply create entities: an entity list
 * nobody pruned is worse than no list, and a matcher that invents a row for
 * every capitalized word fills it in a week. So the pass counts, and a person
 * or an agent decides.
 *
 * Nothing here asks a model. The issue expected the suggestion mechanism to be
 * the expensive half and to need throttling; counting pages turned out to
 * answer the same question for nothing, and a threshold is a better filter than
 * a model's opinion anyway, because it is the same filter tomorrow.
 */
@Injectable()
export class EntityCandidatesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly settings: SettingsService,
    private readonly registry: EntityRegistryService,
    private readonly entities: EntitiesService,
  ) {}

  async list(
    userId: string,
    query: EntityCandidateListQuery,
  ): Promise<EntityCandidateListResponse> {
    const settings = await this.settings.get();
    const threshold = Math.max(
      settings['entities.candidateThreshold'],
      query.minDocuments ?? 0,
    );
    const readable = await this.registry.readableWorkspaceIds(userId);
    if (readable.size === 0 || !settings['entities.candidatesEnabled']) {
      return { threshold, candidates: [] };
    }

    // Counted over the readable workspaces alone: a phrase that crosses the
    // threshold only thanks to pages this caller may not see must not be
    // offered, because the samples underneath it would have to be blank.
    const rows = await this.prisma.entityCandidate.findMany({
      where: {
        dismissedAt: null,
        promotedDocumentId: null,
        sightings: { some: { workspaceId: { in: [...readable] } } },
      },
      orderBy: { lastSeenAt: 'desc' },
      // Read wide, filter down: the threshold applies after the readable
      // workspaces are known, which no `having` on this query can express.
      take: query.limit * 10,
      select: {
        id: true,
        phrase: true,
        firstSeenAt: true,
        lastSeenAt: true,
        sightings: {
          where: { workspaceId: { in: [...readable] }, document: { archivedAt: null } },
          orderBy: { occurrences: 'desc' },
          select: {
            occurrences: true,
            context: true,
            documentId: true,
            document: { select: { title: true } },
          },
        },
      },
    });

    const candidates: EntityCandidate[] = rows
      .filter((row) => row.sightings.length >= threshold)
      .sort((a, b) => b.sightings.length - a.sightings.length)
      .slice(0, query.limit)
      .map((row) => ({
        id: row.id,
        phrase: row.phrase,
        documentCount: row.sightings.length,
        occurrences: row.sightings.reduce((sum, sighting) => sum + sighting.occurrences, 0),
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        samples: row.sightings.slice(0, MAX_SAMPLES).map((sighting) => ({
          documentId: sighting.documentId,
          title: sighting.document.title,
          context: sighting.context,
        })),
      }));

    return { threshold, candidates };
  }

  /**
   * Turns a candidate into an entity.
   *
   * The phrase becomes an alias whether or not the caller renames the entity:
   * the pages that produced the candidate spell it that way, and an entity that
   * does not answer to the name it was found under would start with zero
   * mentions.
   */
  async confirm(input: {
    userId: string;
    candidateId: string;
    request: ConfirmEntityCandidateRequest;
    correlationId: string;
  }): Promise<ConfirmEntityCandidateResponse> {
    const candidate = await this.prisma.entityCandidate.findUnique({
      where: { id: input.candidateId },
      select: { id: true, phrase: true, promotedDocumentId: true },
    });
    if (candidate === null) throw AppError.notFound('Entity candidate');
    if (candidate.promotedDocumentId !== null) {
      throw new AppError(
        'entity_candidate_promoted',
        'This candidate has already become an entity',
      );
    }

    const title = input.request.title ?? candidate.phrase;
    const aliases =
      title.toLowerCase() === candidate.phrase.toLowerCase()
        ? input.request.aliases
        : [candidate.phrase, ...input.request.aliases];

    const created = await this.entities.create({
      userId: input.userId,
      request: { title, type: input.request.type, aliases, summary: '' },
      correlationId: input.correlationId,
    });

    const adopted = await this.adoptSightings(candidate.id, created.entity.id, candidate.phrase);

    await this.prisma.entityCandidate.update({
      where: { id: candidate.id },
      data: { promotedDocumentId: created.entity.id },
    });

    this.logger.info('Entity candidate confirmed', {
      correlationId: input.correlationId,
      candidateId: candidate.id,
      entityId: created.entity.id,
      adoptedMentions: adopted,
    });

    return {
      entity: { ...created.entity, mentionCount: adopted },
      adoptedMentions: adopted,
    };
  }

  /**
   * Turns the evidence into edges straight away.
   *
   * The rescan job would find the same pages, but it runs whenever the worker
   * gets to it, and a confirmation that answers with an empty profile reads as
   * a broken feature. The job still runs and still finds the pages this misses,
   * because a sighting is only kept while its page is one of the reasons the
   * candidate crossed the threshold.
   */
  private async adoptSightings(
    candidateId: string,
    entityId: string,
    phrase: string,
  ): Promise<number> {
    const sightings = await this.prisma.entityCandidateSighting.findMany({
      where: { candidateId, document: { archivedAt: null } },
      select: { documentId: true, workspaceId: true, occurrences: true, context: true },
    });

    let adopted = 0;
    for (const sighting of sightings) {
      if (sighting.documentId === entityId) continue;
      await this.prisma.entityMention.upsert({
        where: {
          entityDocumentId_documentId: {
            entityDocumentId: entityId,
            documentId: sighting.documentId,
          },
        },
        create: {
          entityDocumentId: entityId,
          documentId: sighting.documentId,
          workspaceId: sighting.workspaceId,
          alias: phrase,
          aliasKey: phrase.toLowerCase(),
          occurrences: sighting.occurrences,
          context: sighting.context,
          source: 'EXTRACTED',
        },
        update: { occurrences: sighting.occurrences, lastSeenAt: new Date() },
      });
      adopted += 1;
    }
    return adopted;
  }

  /**
   * Says no, permanently.
   *
   * Recorded rather than deleted. A dismissal that vanished would be undone by
   * the next save of any page carrying the phrase, and a suggestion list that
   * resurrects what you threw away is one nobody opens twice.
   */
  async dismiss(input: {
    userId: string;
    candidateId: string;
  }): Promise<DismissEntityCandidateResponse> {
    const candidate = await this.prisma.entityCandidate.findUnique({
      where: { id: input.candidateId },
      select: { id: true, phrase: true, dismissedAt: true },
    });
    if (candidate === null) throw AppError.notFound('Entity candidate');

    const dismissedAt = candidate.dismissedAt ?? new Date();
    if (candidate.dismissedAt === null) {
      await this.prisma.entityCandidate.update({
        where: { id: candidate.id },
        data: { dismissedAt },
      });
      // The evidence goes with the decision: it is only ever read to decide,
      // and keeping it would mean carrying rows for every word somebody
      // rejected for as long as the deployment lives.
      await this.prisma.entityCandidateSighting.deleteMany({ where: { candidateId: candidate.id } });
    }

    return {
      id: candidate.id,
      phrase: candidate.phrase,
      dismissedAt: dismissedAt.toISOString(),
    };
  }
}
