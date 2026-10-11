import { Inject, Injectable } from '@nestjs/common';

import { WorkspaceAccessService } from '@exocortex/auth';
import { type AiRunInspection, attentionResolutionSchema } from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { KIND_FROM_PRISMA, STATUS_FROM } from '../attention/attention-mapper';
import { STATUS_FROM_PRISMA as CHANGESET_STATUS_FROM_PRISMA } from '../changesets/changeset-mapper';
import { AppError } from '../common/app-error';
import { readerLocale, type ReaderLocaleHeaders } from '../common/reader-locale';
import { PRISMA } from '../platform/platform.module';

import {
  buildRunInspection,
  parseEvents,
  referencedIds,
  type RunRelations,
} from './run-inspection';
import { mapAiRunRow } from './run-mapper';

/**
 * The run inspector's reads (issue #145, ADR-073).
 *
 * Who may inspect a run is who may read it (`GET /api/ai/runs/:id`): a
 * member of its workspace. The inspection shows less than that read does --
 * no prompt, no answer, only sizes, names and outcomes -- and names a page
 * only by a title the same member could open anyway, because the titles are
 * looked up in the run's workspace and nowhere else.
 */
@Injectable()
export class RunInspectionService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
  ) {}

  async inspect(
    runId: string,
    userId: string,
    headers: ReaderLocaleHeaders,
  ): Promise<AiRunInspection> {
    const row = await this.prisma.aiRun.findUnique({ where: { id: runId } });
    if (row === null) throw AppError.notFound('AI run');
    await this.access.requireRole(row.workspaceId, userId);

    const [eventRows, relations] = await Promise.all([
      this.prisma.aiRunEvent.findMany({
        where: { runId },
        orderBy: { sequence: 'asc' },
        select: { sequence: true, kind: true, at: true, durationMs: true, data: true },
      }),
      this.loadRelations(runId),
    ]);
    const ids = referencedIds(parseEvents(eventRows));
    const [documents, savedQueries] = await Promise.all([
      this.prisma.document.findMany({
        where: { id: { in: ids.documentIds }, workspaceId: row.workspaceId },
        select: { id: true, title: true },
      }),
      this.prisma.savedQuery.findMany({
        where: { id: { in: ids.savedQueryIds }, workspaceId: row.workspaceId },
        select: { id: true, name: true },
      }),
    ]);

    const run = mapAiRunRow(row, await readerLocale(this.prisma, userId, headers));
    return buildRunInspection({
      // The answer is the run's, not the inspector's: it stays behind
      // `GET /api/ai/runs/:id`, and the inspection carries no text at all.
      run: { ...run, resultText: null },
      row,
      events: eventRows,
      relations,
      titles: {
        documents: new Map(documents.map((document) => [document.id, document.title])),
        savedQueries: new Map(savedQueries.map((query) => [query.id, query.name])),
      },
    });
  }

  /** What other tables already know about the run; never copied into its timeline. */
  private async loadRelations(runId: string): Promise<RunRelations> {
    const [attention, changesets, checkpoints, resumedFrom] = await Promise.all([
      this.prisma.attentionItem.findMany({
        where: { aiRunId: runId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          kind: true,
          status: true,
          title: true,
          blocking: true,
          createdAt: true,
          settledAt: true,
          resolution: true,
        },
      }),
      this.prisma.changeset.findMany({
        where: { aiRunId: runId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, title: true, status: true, createdAt: true },
      }),
      this.prisma.workItemCheckpoint.findMany({
        where: { aiRunId: runId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, trigger: true, createdAt: true },
      }),
      // The answers that carried an earlier run on in this one (ADR-068).
      this.prisma.attentionItem.findMany({
        where: { resolution: { path: ['resumedRunId'], equals: runId } },
        select: { aiRunId: true, settledAt: true, createdAt: true },
      }),
    ]);

    return {
      attention: attention.map((item) => {
        const resolution = attentionResolutionSchema.safeParse(item.resolution);
        return {
          id: item.id,
          kind: KIND_FROM_PRISMA[item.kind],
          status: STATUS_FROM[item.status],
          title: item.title,
          blocking: item.blocking,
          createdAt: item.createdAt,
          settledAt: item.settledAt,
          resumedRunId: resolution.success ? (resolution.data.resumedRunId ?? null) : null,
        };
      }),
      changesets: changesets.map((changeset) => ({
        ...changeset,
        status: CHANGESET_STATUS_FROM_PRISMA[changeset.status],
      })),
      checkpoints: checkpoints.map((checkpoint) => ({
        ...checkpoint,
        trigger: checkpoint.trigger.toLowerCase(),
      })),
      resumedFrom: resumedFrom.flatMap((item) =>
        item.aiRunId === null || item.aiRunId === runId
          ? []
          : [{ runId: item.aiRunId, at: item.settledAt ?? item.createdAt }],
      ),
    };
  }
}
