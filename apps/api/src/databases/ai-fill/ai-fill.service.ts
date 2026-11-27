import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
  assertPolicy,
  canEditDocument,
  canReadDocument,
  type DocumentAccessContext,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  aiFillInstructionText,
  type AiFillMode,
  type AiFillOrigin,
  type AiFillRun,
  type AiFillRunDetail,
  type AiFillStartResponse,
  isAiFillableType,
  isEmptyCellValue,
  QUEUE_NAMES,
  type StartAiFillRequest,
  startAiFillRequestSchema,
} from '@exocortex/contracts';
import { loadDatabaseScope, type PrismaClient } from '@exocortex/database';
import { QueueRegistry } from '@exocortex/queue';

import { AiModelResolverService } from '../../ai/ai-model-resolver.service';
import { AppError } from '../../common/app-error';
import { PRISMA, QUEUES } from '../../platform/platform.module';
import { SettingsService } from '../../platform/settings.service';
import { RealtimeService } from '../../realtime/realtime.service';
import { DatabaseRowsService } from '../database-rows.service';
import { storedToResponseValue } from '../row-values';

import {
  AI_FILL_RUN_INCLUDE,
  type AiFillRunRow,
  countsFrom,
  modeFromColumn,
  modeToColumn,
  presetFromColumn,
  toAiFillCellResponse,
  toAiFillRunResponse,
} from './ai-fill-mapper';

const ACTIVE_STATUSES = ['PENDING', 'RUNNING'] as const;
const RUN_LIST_LIMIT = 20;

type StartRequest = z.output<typeof startAiFillRequestSchema>;

/**
 * Starting, reading, cancelling and retrying the AI fill of a database
 * column (issue #237, ADR-099). This is where it is decided which cells a
 * batch may write; the worker only asks the model and hands each answer back
 * to `AiFillWorkerService`, which checks it again against the cell as it is
 * by then.
 *
 * A batch is an `ai_run` of kind FILL (so the usage report and the reaper see
 * it like any run), a `database_ai_fill_run` holding the instruction it was
 * started with, and one `database_ai_fill_cell` per row.
 */
@Injectable()
export class AiFillService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    private readonly access: WorkspaceAccessService,
    private readonly rows: DatabaseRowsService,
    private readonly settings: SettingsService,
    private readonly models: AiModelResolverService,
    private readonly realtime: RealtimeService,
  ) {}

  async start(input: {
    collectionDocumentId: string;
    userId: string;
    request: StartAiFillRequest;
    correlationId: string;
    origin?: AiFillOrigin;
  }): Promise<AiFillStartResponse> {
    const request: StartRequest = startAiFillRequestSchema.parse(input.request);
    const collection = await this.rows.requireCollection(input.collectionDocumentId, input.userId);
    assertPolicy(canReadDocument(collection.role, collection.document, collection.workspaceId));

    const property = await this.prisma.databaseProperty.findUnique({
      where: { id: request.propertyId },
      include: { ai: true },
    });
    if (property === null || property.documentId !== input.collectionDocumentId) {
      throw AppError.notFound('Database property');
    }
    if (property.ai === null) {
      throw new AppError('ai_fill_not_configured', 'This column has no AI instruction');
    }
    if (!isAiFillableType(property.type)) {
      throw new AppError('database_property_ai_invalid', 'This column cannot be filled by AI', {
        reason: 'type_unsupported',
      });
    }

    const settings = await this.settings.getForWorkspace(collection.workspaceId);
    if (!settings['ai.enabled']) {
      throw new AppError('ai_fill_unavailable', 'AI is switched off for this deployment');
    }
    const limit = settings['ai.fillMaxRowsPerRun'];

    const named = request.rowIds === undefined ? null : [...new Set(request.rowIds)];
    if (named !== null && named.length > limit) {
      throw new AppError(
        'ai_fill_too_many_rows',
        `One AI fill holds at most ${String(limit)} rows (ai.fillMaxRowsPerRun)`,
        { limit },
      );
    }
    if (named !== null) {
      await this.rows.requireRowsOf({
        collectionDocumentId: input.collectionDocumentId,
        rowIds: named,
        userId: input.userId,
        check: (context) => assertPolicy(canEditDocument(context.role, context.document)),
      });
    }
    const rowIds = named ?? (await this.allRowIds(input.collectionDocumentId));

    const plan = await this.plan({
      collectionDocumentId: input.collectionDocumentId,
      propertyId: property.id,
      rowIds,
      mode: request.mode,
      limit,
      userId: input.userId,
      checkEach: named === null,
    });

    const counts = {
      candidates: plan.candidates,
      queued: plan.queue.length,
      skippedNotEmpty: plan.skippedNotEmpty,
      skippedForbidden: plan.skippedForbidden,
      skippedActive: plan.skippedActive,
      remaining: Math.max(0, plan.candidates - plan.queue.length),
      limit,
    };
    if (request.dryRun || plan.queue.length === 0) return { run: null, ...counts };

    const model = await this.models.resolveDefault(collection.workspaceId);
    const ai = property.ai;
    const instruction = aiFillInstructionText({
      preset: presetFromColumn(ai.preset),
      instruction: ai.instruction,
      targetLanguage: ai.targetLanguage,
    });

    const runId = await this.prisma.$transaction(async (tx) => {
      const run = await tx.aiRun.create({
        data: {
          kind: 'FILL',
          workspaceId: collection.workspaceId,
          documentId: input.collectionDocumentId,
          createdById: input.userId,
          status: 'PENDING',
          provider: model.provider,
          model: model.slug,
          messages: [{ role: 'user', content: instruction }],
          correlationId: input.correlationId,
        },
        select: { id: true },
      });
      await tx.databaseAiFillRun.create({
        data: {
          aiRunId: run.id,
          databaseId: input.collectionDocumentId,
          propertyId: property.id,
          mode: modeToColumn(request.mode),
          origin: input.origin === 'automatic' ? 'AUTOMATIC' : 'MANUAL',
          preset: ai.preset,
          instruction: ai.instruction,
          targetLanguage: ai.targetLanguage,
          allowNewOptions: ai.allowNewOptions,
          useContent: ai.useContent,
          useProperties: ai.useProperties,
          useAttachments: ai.useAttachments,
        },
      });
      await tx.databaseAiFillCell.createMany({
        data: plan.queue.map((rowId, position) => ({
          aiRunId: run.id,
          rowId,
          propertyId: property.id,
          position,
        })),
      });
      return run.id;
    });

    await this.queues.enqueue(
      QUEUE_NAMES.databaseAiFill,
      {
        kind: 'run',
        runId,
        workspaceId: collection.workspaceId,
        correlationId: input.correlationId,
      },
      { jobId: `ai-fill-${runId}` },
    );
    await this.announce(
      collection.workspaceId,
      input.collectionDocumentId,
      runId,
      'pending',
      input.correlationId,
    );

    return { run: await this.summary(runId), ...counts };
  }

  /**
   * Which of `rowIds` this batch takes, and why the others are left out.
   *
   * For the whole column the rows are checked one by one, in the database's
   * order, until the batch is full: a share can let somebody change one row
   * and not the next (ADR-044), and checking all of a large database to fill
   * a hundred of its rows would be wasted work.
   */
  private async plan(input: {
    collectionDocumentId: string;
    propertyId: string;
    rowIds: readonly string[];
    mode: AiFillMode;
    limit: number;
    userId: string;
    checkEach: boolean;
  }): Promise<{
    queue: string[];
    candidates: number;
    skippedNotEmpty: number;
    skippedForbidden: number;
    skippedActive: number;
  }> {
    const scope = await loadDatabaseScope(this.prisma, input.collectionDocumentId);
    const propertyRef = scope.properties.get(input.propertyId);
    if (propertyRef === undefined) throw AppError.notFound('Database property');

    const [values, active] = await Promise.all([
      this.prisma.documentPropertyValue.findMany({
        where: { propertyId: input.propertyId, documentId: { in: [...input.rowIds] } },
      }),
      this.prisma.databaseAiFillCell.findMany({
        where: {
          propertyId: input.propertyId,
          rowId: { in: [...input.rowIds] },
          status: { in: ['QUEUED', 'RUNNING'] },
          run: { aiRun: { status: { in: [...ACTIVE_STATUSES] } } },
        },
        select: { rowId: true },
      }),
    ]);
    const valueOf = new Map(values.map((value) => [value.documentId, value]));
    const busy = new Set(active.map((cell) => cell.rowId));

    let skippedNotEmpty = 0;
    let skippedActive = 0;
    const candidates: string[] = [];
    for (const rowId of input.rowIds) {
      const stored = valueOf.get(rowId);
      const empty = isEmptyCellValue(storedToResponseValue(propertyRef, stored));
      const allowed =
        input.mode === 'replace_all' ||
        empty ||
        (input.mode === 'replace_ai' && stored?.aiRunId !== null && stored?.aiRunId !== undefined);
      if (!allowed) {
        skippedNotEmpty += 1;
        continue;
      }
      if (busy.has(rowId)) {
        skippedActive += 1;
        continue;
      }
      candidates.push(rowId);
    }

    if (!input.checkEach) {
      return {
        queue: candidates.slice(0, input.limit),
        candidates: candidates.length,
        skippedNotEmpty,
        skippedForbidden: 0,
        skippedActive,
      };
    }

    const queue: string[] = [];
    let skippedForbidden = 0;
    for (const rowId of candidates) {
      if (queue.length >= input.limit) break;
      if (await this.mayEdit(rowId, input.userId)) queue.push(rowId);
      else skippedForbidden += 1;
    }
    return {
      queue,
      candidates: candidates.length - skippedForbidden,
      skippedNotEmpty,
      skippedForbidden,
      skippedActive,
    };
  }

  private async mayEdit(rowId: string, userId: string): Promise<boolean> {
    let context: DocumentAccessContext;
    try {
      context = await this.access.requireDocumentContext(rowId, userId);
    } catch {
      // No access at all is the same answer as no right to edit: the row is
      // left out, and the count says that some were.
      return false;
    }
    return canEditDocument(context.role, context.document).allowed;
  }

  private async allRowIds(collectionDocumentId: string): Promise<string[]> {
    const rows = await this.prisma.document.findMany({
      where: { parentId: collectionDocumentId, type: 'PAGE', archivedAt: null },
      orderBy: [{ orderKey: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** The batches of one database, newest first; `active` keeps the ones still working. */
  async list(input: {
    collectionDocumentId: string;
    userId: string;
    active: boolean;
  }): Promise<AiFillRun[]> {
    const collection = await this.rows.requireCollection(input.collectionDocumentId, input.userId);
    assertPolicy(canReadDocument(collection.role, collection.document, collection.workspaceId));
    const rows = await this.prisma.databaseAiFillRun.findMany({
      where: {
        databaseId: input.collectionDocumentId,
        ...(input.active ? { aiRun: { status: { in: [...ACTIVE_STATUSES] } } } : {}),
      },
      include: AI_FILL_RUN_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: RUN_LIST_LIMIT,
    });
    return this.withCounts(rows);
  }

  async get(runId: string, userId: string): Promise<AiFillRunDetail> {
    const row = await this.requireRun(runId, userId, 'read');
    const [run] = await this.withCounts([row]);
    const cells = await this.prisma.databaseAiFillCell.findMany({
      where: { aiRunId: runId },
      orderBy: { position: 'asc' },
      include: { row: { select: { title: true } } },
    });
    if (run === undefined) throw AppError.notFound('AI fill');
    return {
      ...run,
      cells: cells.map((cell) => toAiFillCellResponse(cell, cell.row.title)),
    };
  }

  /**
   * Stops a batch. The cells still waiting are cancelled here, and the worker
   * stops before its next cell; an answer that arrives for a cell already
   * asked is not written (`AiFillWorkerService.result`).
   */
  async cancel(runId: string, userId: string, correlationId: string): Promise<AiFillRun> {
    const row = await this.requireRun(runId, userId, 'cancel');
    const now = new Date();
    const cancelled = await this.prisma.aiRun.updateMany({
      where: { id: runId, status: { in: [...ACTIVE_STATUSES] } },
      data: { status: 'CANCELLED', cancelledAt: now, finishedAt: now },
    });
    if (cancelled.count === 0) {
      throw new AppError('ai_fill_finished', 'The AI fill has already finished');
    }
    await this.prisma.databaseAiFillCell.updateMany({
      where: { aiRunId: runId, status: 'QUEUED' },
      data: { status: 'CANCELLED', errorCode: 'run_ended', finishedAt: now },
    });
    const workspaceId = await this.workspaceOf(row.databaseId);
    await this.announce(workspaceId, row.databaseId, runId, 'cancelled', correlationId);
    return this.summary(runId);
  }

  /**
   * A new batch for the cells of a finished one that did not end well: the
   * failed, the cancelled and the ones a lost worker never reached. Same
   * column and mode; the instruction is the column's as it is now.
   */
  async retry(runId: string, userId: string, correlationId: string): Promise<AiFillStartResponse> {
    const row = await this.requireRun(runId, userId, 'read');
    if ((ACTIVE_STATUSES as readonly string[]).includes(row.aiRun.status)) {
      throw AppError.conflict('The AI fill is still running');
    }
    const cells = await this.prisma.databaseAiFillCell.findMany({
      where: {
        aiRunId: runId,
        status: { in: ['FAILED', 'CANCELLED', 'QUEUED', 'RUNNING'] },
        row: { archivedAt: null, parentId: row.databaseId },
      },
      orderBy: { position: 'asc' },
      select: { rowId: true },
    });
    if (cells.length === 0) {
      const settings = await this.settings.getForWorkspace(await this.workspaceOf(row.databaseId));
      return {
        run: null,
        candidates: 0,
        queued: 0,
        skippedNotEmpty: 0,
        skippedForbidden: 0,
        skippedActive: 0,
        remaining: 0,
        limit: settings['ai.fillMaxRowsPerRun'],
      };
    }
    return this.start({
      collectionDocumentId: row.databaseId,
      userId,
      correlationId,
      request: {
        propertyId: row.propertyId,
        rowIds: cells.map((cell) => cell.rowId),
        mode: modeFromColumn(row.mode),
      },
    });
  }

  async summary(runId: string): Promise<AiFillRun> {
    const row = await this.prisma.databaseAiFillRun.findUnique({
      where: { aiRunId: runId },
      include: AI_FILL_RUN_INCLUDE,
    });
    if (row === null) throw AppError.notFound('AI fill');
    const [run] = await this.withCounts([row]);
    if (run === undefined) throw AppError.notFound('AI fill');
    return run;
  }

  private async withCounts(rows: readonly AiFillRunRow[]): Promise<AiFillRun[]> {
    if (rows.length === 0) return [];
    const groups = await this.prisma.databaseAiFillCell.groupBy({
      by: ['aiRunId', 'status'],
      where: { aiRunId: { in: rows.map((row) => row.aiRunId) } },
      _count: { _all: true },
    });
    return rows.map((row) =>
      toAiFillRunResponse(row, countsFrom(groups.filter((group) => group.aiRunId === row.aiRunId))),
    );
  }

  /**
   * The batch, after checking the caller may see it -- or stop it, which is
   * the person who started it or anybody who may change the database.
   */
  private async requireRun(
    runId: string,
    userId: string,
    purpose: 'read' | 'cancel',
  ): Promise<AiFillRunRow> {
    const row = await this.prisma.databaseAiFillRun.findUnique({
      where: { aiRunId: runId },
      include: AI_FILL_RUN_INCLUDE,
    });
    if (row === null) throw AppError.notFound('AI fill');
    const context = await this.access.requireDocumentContext(row.databaseId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));
    if (purpose === 'cancel' && row.aiRun.createdById !== userId) {
      assertPolicy(canEditDocument(context.role, context.document));
    }
    return row;
  }

  private async workspaceOf(documentId: string): Promise<string> {
    const document = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { workspaceId: true },
    });
    if (document === null) throw AppError.notFound('Database');
    return document.workspaceId;
  }

  async announce(
    workspaceId: string,
    databaseId: string,
    runId: string,
    status: AiFillRun['status'],
    correlationId: string,
  ): Promise<void> {
    await this.realtime.emit('database.ai_fill.changed', workspaceId, correlationId, {
      documentId: databaseId,
      runId,
      status,
    });
  }
}
