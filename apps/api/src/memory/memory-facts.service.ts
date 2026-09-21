import { Inject, Injectable } from '@nestjs/common';

import { type ApiEnv } from '@exocortex/config';
import {
  type MemoryConsolidateRequest,
  type MemoryConsolidateResponse,
  type MemoryFact as MemoryFactDto,
  type MemoryFactListQuery,
  type MemoryFactListResponse,
  type MemoryFactPromoteRequest,
  type MemoryFactPromoteResponse,
  type MemoryFactStatus as MemoryFactStatusDto,
  type MemoryFactVerdict,
} from '@exocortex/contracts';
import { type MemoryFactStatus, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { DocumentContentService } from '../documents/document-content.service';
import { DocumentsService } from '../documents/documents.service';
import { PRISMA } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

import { normaliseProject, projectLabel } from './memory-project';
import { memoryWorkspaceFor } from './memory-workspace';

/** Title of the page every project's facts hang under, inside the memory workspace. */
const FACTS_PAGE_TITLE = 'Fakten';
/** Detail text carried in a listing. The page holds the rest. */
const MAX_DETAIL_CHARS = 800;
/** Evidence notes reported per fact. */
const MAX_SOURCES = 10;

/** Confidence a fact starts with when a single note first says it. */
const INITIAL_CONFIDENCE = 0.5;
/**
 * Confidence a correction starts with. Above a first sighting on purpose: a
 * note that contradicts something the memory already held is a deliberate
 * statement about the present, not an observation in passing.
 */
const CORRECTION_CONFIDENCE = 0.6;
/**
 * How far a confirmation closes the gap to certainty. Multiplicative rather
 * than additive, so the tenth confirmation moves a fact far less than the
 * second and nothing ever reaches 1: a memory that is certain has stopped
 * being able to learn it was wrong.
 */
const CONFIRMATION_GAIN = 0.3;

const STATUS_TO_DTO: Record<MemoryFactStatus, MemoryFactStatusDto> = {
  CURRENT: 'current',
  SUPERSEDED: 'superseded',
  CONFLICTED: 'conflicted',
};
const STATUS_FROM_DTO: Record<MemoryFactStatusDto, MemoryFactStatus> = {
  current: 'CURRENT',
  superseded: 'SUPERSEDED',
  conflicted: 'CONFLICTED',
};

/**
 * The distilled layer above the session notes (issue #46).
 *
 * A note says what happened once; a fact says what holds until further notice.
 * Everything here is about that difference: a fact is confirmed rather than
 * repeated, replaced rather than edited, and it fades rather than expiring on a
 * birthday.
 *
 * The wording of a fact is an ordinary page, written through the ordinary
 * document services, so it is searchable, embeddable, versioned and readable by
 * a human without one line of new rendering (ADR-016 applies to it exactly as
 * it applies to anything else). This service owns only the metadata a page
 * cannot carry.
 */
@Injectable()
export class MemoryFactsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly settings: SettingsService,
    private readonly documents: DocumentsService,
    private readonly content: DocumentContentService,
  ) {}

  /** The facts of a project, best first. Reads nothing outside the memory workspace. */
  async list(userId: string, query: MemoryFactListQuery): Promise<MemoryFactListResponse> {
    const workspaceId = await this.requireReadableMemoryWorkspace(userId);
    const projectKey = query.project === undefined ? null : normaliseProject(query.project);
    const statuses = query.status.map((status) => STATUS_FROM_DTO[status]);

    const where = {
      workspaceId,
      ...(projectKey === null ? {} : { projectKey }),
      document: { archivedAt: null },
    };

    const [rows, total] = await Promise.all([
      this.prisma.memoryFact.findMany({
        where: { ...where, status: { in: statuses } },
        orderBy: [{ confidence: 'desc' }, { lastConfirmedAt: 'desc' }],
        take: query.limit,
        include: {
          document: { select: { title: true, content: { select: { plainText: true } } } },
          sources: {
            select: { noteId: true },
            orderBy: { createdAt: 'desc' },
            take: MAX_SOURCES,
          },
        },
      }),
      this.prisma.memoryFact.count({ where }),
    ]);

    return {
      project: projectKey,
      facts: rows.map((row) => toDto(row)),
      omitted: Math.max(0, total - rows.length),
    };
  }

  /**
   * Applies one consolidation run.
   *
   * Every note in `noteIds` is marked as read, verdicts or not: that mark is
   * the cursor of the whole mechanism, and without it tonight's batch would be
   * tomorrow's batch for ever. A verdict naming a note outside the batch or a
   * fact that does not exist is counted and dropped rather than applied, which
   * is the shape a hallucinated id arrives in.
   */
  async consolidate(input: {
    userId: string;
    request: MemoryConsolidateRequest;
    correlationId: string;
  }): Promise<MemoryConsolidateResponse> {
    const workspaceId = await this.requireReadableMemoryWorkspace(input.userId);
    const projectKey = normaliseProject(input.request.project);

    const notes = await this.prisma.document.findMany({
      where: { id: { in: input.request.noteIds }, workspaceId, archivedAt: null },
      select: { id: true },
    });
    const knownNotes = new Set(notes.map((note) => note.id));

    const counts = { created: 0, confirmed: 0, superseded: 0, conflicted: 0, discarded: 0 };
    let rejected = 0;
    let factsPage: string | null = null;

    for (const verdict of input.request.verdicts) {
      if (!knownNotes.has(verdict.noteId)) {
        rejected += 1;
        continue;
      }
      if (verdict.kind === 'discard') {
        counts.discarded += 1;
        continue;
      }
      if (verdict.kind === 'new' || verdict.kind === 'supersedes') {
        factsPage ??= await this.findOrCreateFactsPage({
          workspaceId,
          userId: input.userId,
          projectKey,
          correlationId: input.correlationId,
        });
      }
      const applied = await this.applyVerdict({
        verdict,
        workspaceId,
        projectKey,
        factsPageId: factsPage,
        userId: input.userId,
        correlationId: input.correlationId,
      });
      if (applied === null) rejected += 1;
      else counts[applied] += 1;
    }

    await this.markNotesRead([...knownNotes], counts.created + counts.confirmed);

    this.logger.info('Memory consolidation applied', {
      correlationId: input.correlationId,
      workspaceId,
      project: projectKey,
      notesRead: knownNotes.size,
      ...counts,
      rejected,
    });

    return { project: projectKey, notesRead: knownNotes.size, ...counts, rejected };
  }

  /**
   * Copies a fact into the curated brain.
   *
   * Deliberately a separate call rather than a step of consolidation: the
   * memory workspace is the agents' and may be swept, the brain is a person's
   * and is not (ADR-019). Crossing that line is somebody's decision.
   */
  async promote(input: {
    userId: string;
    factId: string;
    request: MemoryFactPromoteRequest;
    correlationId: string;
  }): Promise<MemoryFactPromoteResponse> {
    const workspaceId = await this.requireReadableMemoryWorkspace(input.userId);
    const fact = await this.prisma.memoryFact.findFirst({
      where: { id: input.factId, workspaceId },
      include: { document: { select: { title: true, content: { select: { markdown: true } } } } },
    });
    if (fact === null) throw AppError.notFound('Memory fact');

    if (fact.promotedDocumentId !== null) {
      const existing = await this.prisma.document.findFirst({
        where: { id: fact.promotedDocumentId, archivedAt: null },
        select: { id: true, workspaceId: true, title: true },
      });
      if (existing !== null) {
        return {
          factId: fact.id,
          documentId: existing.id,
          workspaceId: existing.workspaceId,
          title: existing.title,
          url: this.documentUrl(existing.workspaceId, existing.id),
          alreadyPromoted: true,
        };
      }
    }

    const created = await this.documents.create({
      workspaceId: input.request.workspaceId,
      userId: input.userId,
      request: {
        type: 'PAGE',
        title: fact.document.title,
        parentId: input.request.parentId ?? undefined,
      },
      correlationId: input.correlationId,
    });
    await this.content.write({
      documentId: created.id,
      userId: input.userId,
      request: {
        markdown: promotedBody(fact.document.content?.markdown ?? '', fact),
        mode: 'replace',
      },
      correlationId: input.correlationId,
      source: 'ai',
      // Same exemption as the session notes: a fact page is written by the
      // consolidation run, not by an agent deciding where to put something.
      growth: 'exempt',
    });
    await this.prisma.memoryFact.update({
      where: { id: fact.id },
      data: { promotedDocumentId: created.id, promotedAt: new Date() },
    });

    this.logger.info('Memory fact promoted into a curated workspace', {
      correlationId: input.correlationId,
      factId: fact.id,
      targetWorkspaceId: input.request.workspaceId,
      documentId: created.id,
    });

    return {
      factId: fact.id,
      documentId: created.id,
      workspaceId: input.request.workspaceId,
      title: created.title,
      url: this.documentUrl(input.request.workspaceId, created.id),
      alreadyPromoted: false,
    };
  }

  /**
   * One verdict. Returns which counter to raise, or null when it named
   * something that is not there.
   */
  private async applyVerdict(input: {
    verdict: MemoryFactVerdict;
    workspaceId: string;
    projectKey: string;
    factsPageId: string | null;
    userId: string;
    correlationId: string;
  }): Promise<'created' | 'confirmed' | 'superseded' | 'conflicted' | null> {
    const { verdict } = input;

    if (verdict.kind === 'new') {
      await this.createFact({ ...input, confidence: INITIAL_CONFIDENCE });
      return 'created';
    }

    const target = await this.prisma.memoryFact.findFirst({
      where: { id: verdict.factId ?? '', workspaceId: input.workspaceId },
      select: { id: true, confidence: true, status: true },
    });
    if (target === null) return null;

    if (verdict.kind === 'confirms') {
      await this.prisma.$transaction([
        this.prisma.memoryFact.update({
          where: { id: target.id },
          data: {
            confidence: target.confidence + (1 - target.confidence) * CONFIRMATION_GAIN,
            confirmations: { increment: 1 },
            lastConfirmedAt: new Date(),
            // A confirmation revives a fact the decay had already put away;
            // it does not resolve a conflict, which needs a human.
            status: target.status === 'SUPERSEDED' ? target.status : 'CURRENT',
          },
        }),
        this.prisma.memoryFactSource.createMany({
          data: [{ factId: target.id, noteId: verdict.noteId, confirming: true }],
          skipDuplicates: true,
        }),
      ]);
      return 'confirmed';
    }

    if (verdict.kind === 'conflicts') {
      await this.prisma.$transaction([
        this.prisma.memoryFact.update({
          where: { id: target.id },
          data: { status: 'CONFLICTED' },
        }),
        this.prisma.memoryFactSource.createMany({
          data: [{ factId: target.id, noteId: verdict.noteId, confirming: false }],
          skipDuplicates: true,
        }),
      ]);
      return 'conflicted';
    }

    const replacement = await this.createFact({ ...input, confidence: CORRECTION_CONFIDENCE });
    await this.prisma.memoryFact.update({
      where: { id: target.id },
      data: { status: 'SUPERSEDED', supersededById: replacement },
    });
    return 'superseded';
  }

  /** Writes the page and the row for a statement the memory has not held before. */
  private async createFact(input: {
    verdict: MemoryFactVerdict;
    workspaceId: string;
    projectKey: string;
    factsPageId: string | null;
    userId: string;
    correlationId: string;
    confidence: number;
  }): Promise<string> {
    const statement = input.verdict.statement ?? '';
    const created = await this.documents.create({
      workspaceId: input.workspaceId,
      userId: input.userId,
      request: {
        type: 'PAGE',
        title: statement.slice(0, 300),
        parentId: input.factsPageId ?? undefined,
      },
      correlationId: input.correlationId,
    });
    await this.content.write({
      documentId: created.id,
      userId: input.userId,
      request: { markdown: factBody(input.verdict), mode: 'replace' },
      correlationId: input.correlationId,
      source: 'ai',
      growth: 'exempt',
    });

    const fact = await this.prisma.memoryFact.create({
      data: {
        documentId: created.id,
        workspaceId: input.workspaceId,
        projectKey: input.projectKey,
        confidence: input.confidence,
        sources: { create: [{ noteId: input.verdict.noteId, confirming: false }] },
      },
      select: { id: true },
    });
    return fact.id;
  }

  /** Marks the whole batch as read. Idempotent, so a repeated run is free. */
  private async markNotesRead(noteIds: readonly string[], factsProduced: number): Promise<void> {
    if (noteIds.length === 0) return;
    await this.prisma.memoryConsolidation.createMany({
      data: noteIds.map((noteId) => ({ noteId, factsProduced })),
      skipDuplicates: true,
    });
  }

  /**
   * The page a project's facts hang under, created on first use.
   *
   * A child of the project page, beside the session notes rather than mixed
   * into them: a person opening the memory workspace should be able to read
   * what is known without reading what happened.
   */
  private async findOrCreateFactsPage(input: {
    workspaceId: string;
    userId: string;
    projectKey: string;
    correlationId: string;
  }): Promise<string> {
    const projectTitle = projectLabel(input.projectKey);
    const projectPage = await this.prisma.document.findFirst({
      where: {
        workspaceId: input.workspaceId,
        parentId: null,
        title: projectTitle,
        archivedAt: null,
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (projectPage === null) {
      throw new AppError(
        'memory_unavailable',
        'The project has no page in the memory workspace yet; nothing has been remembered for it',
      );
    }

    const existing = await this.prisma.document.findFirst({
      where: {
        workspaceId: input.workspaceId,
        parentId: projectPage.id,
        title: FACTS_PAGE_TITLE,
        archivedAt: null,
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing !== null) return existing.id;

    const created = await this.documents.create({
      workspaceId: input.workspaceId,
      userId: input.userId,
      request: { type: 'PAGE', title: FACTS_PAGE_TITLE, parentId: projectPage.id },
      correlationId: input.correlationId,
    });
    await this.content.write({
      documentId: created.id,
      userId: input.userId,
      request: {
        markdown:
          'Verdichtete Aussagen aus den Sitzungsnotizen darüber. Jede Unterseite ist ein Fakt: eine Aussage, die gilt, bis eine spätere Notiz sie ersetzt.\n',
        mode: 'replace',
      },
      correlationId: input.correlationId,
      source: 'ai',
      growth: 'exempt',
    });
    return created.id;
  }

  /**
   * The caller's memory area, or a refusal they can act on.
   *
   * No separate membership check any more: resolution goes through the
   * caller's own memberships (issue #52), so an id that comes back is by
   * construction one they may write to.
   */
  private async requireReadableMemoryWorkspace(userId: string): Promise<string> {
    const settings = await this.settings.get();
    if (!settings['memory.enabled']) {
      throw new AppError(
        'memory_unavailable',
        'The memory area is switched off for this deployment',
      );
    }
    const workspaceId = await memoryWorkspaceFor(this.prisma, userId);
    if (workspaceId === null) {
      throw new AppError(
        'memory_unavailable',
        'This account has no memory workspace; mark one of its workspaces as the memory area',
      );
    }
    return workspaceId;
  }

  private documentUrl(workspaceId: string, documentId: string): string | null {
    try {
      return new URL(
        `/arbeitsbereich/${workspaceId}/seite/${documentId}`,
        this.env.APP_URL,
      ).toString();
    } catch {
      return null;
    }
  }
}

interface FactRow {
  id: string;
  documentId: string;
  workspaceId: string;
  projectKey: string;
  status: MemoryFactStatus;
  confidence: number;
  confirmations: number;
  firstSeenAt: Date;
  lastConfirmedAt: Date;
  supersededById: string | null;
  promotedDocumentId: string | null;
  promotedAt: Date | null;
  document: { title: string; content: { plainText: string | null } | null };
  sources: { noteId: string }[];
}

function toDto(row: FactRow): MemoryFactDto {
  const plain = (row.document.content?.plainText ?? '').replace(/\s+/g, ' ').trim();
  return {
    id: row.id,
    documentId: row.documentId,
    workspaceId: row.workspaceId,
    projectKey: row.projectKey,
    statement: row.document.title,
    detail: plain.length <= MAX_DETAIL_CHARS ? plain : `${plain.slice(0, MAX_DETAIL_CHARS)}…`,
    status: STATUS_TO_DTO[row.status],
    confidence: row.confidence,
    confirmations: row.confirmations,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastConfirmedAt: row.lastConfirmedAt.toISOString(),
    supersededById: row.supersededById,
    promotedDocumentId: row.promotedDocumentId,
    promotedAt: row.promotedAt?.toISOString() ?? null,
    sourceNoteIds: row.sources.map((source) => source.noteId),
  };
}

/** The body of a fact page. The statement is the title; this is the elaboration. */
function factBody(verdict: MemoryFactVerdict): string {
  const detail = verdict.detail.trim();
  return detail.length === 0 ? `${verdict.statement ?? ''}\n` : `${detail}\n`;
}

/**
 * What lands in the brain. The wording, plus one line saying where it came
 * from: a promoted fact that cannot be traced back is a claim without a source.
 */
function promotedBody(markdown: string, fact: { id: string; confirmations: number }): string {
  const body = markdown.trim();
  const note = `_Aus dem Gedächtnis der Agenten übernommen (${fact.confirmations}× bestätigt, Fakt ${fact.id})._`;
  return body.length === 0 ? `${note}\n` : `${body}\n\n${note}\n`;
}
