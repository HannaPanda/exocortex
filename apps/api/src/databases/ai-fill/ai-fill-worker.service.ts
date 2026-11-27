import { Inject, Injectable } from '@nestjs/common';

import {
  canEditDocument,
  canManageDatabaseSchema,
  canReadDocument,
  type DocumentAccessContext,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type AiFillAnswerValue,
  type AiFillCellErrorCode,
  type AiFillCellResultRequest,
  type AiFillCellResultResponse,
  aiFillInstructionText,
  type AiFillMaterial,
  attachmentTrustFor,
  coerceAiFillAnswer,
  type DatabaseRow,
  type DatabaseRowPropertyValue,
  isAiFillableType,
  isEmptyCellValue,
  parseDatePropertyConfig,
  screeningFromColumn,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../../common/app-error';
import { currentAiRunId, currentCorrelationId } from '../../common/correlation';
import { PRISMA } from '../../platform/platform.module';
import { DatabasePropertiesService } from '../database-properties.service';
import { DatabaseRowsService } from '../database-rows.service';

import { AiFillService } from './ai-fill.service';
import { cellStatusFromColumn, modeFromColumn, presetFromColumn } from './ai-fill-mapper';

/** How much of a row's page the model reads. */
const CONTENT_MAX_CHARS = 20_000;
/** How much of one file, and of all files together. */
const ATTACHMENT_MAX_CHARS = 12_000;
const ATTACHMENTS_TOTAL_MAX_CHARS = 30_000;
const ATTACHMENTS_MAX = 10;
/** A value of another column, as the model reads it. */
const PROPERTY_VALUE_MAX_CHARS = 500;
const MEMBERS_MAX = 200;

type CellRow = Awaited<ReturnType<AiFillWorkerService['requireCell']>>;

/**
 * The two routes the worker calls for every cell of a batch (issue #237,
 * ADR-099), and nobody else: the service token has to carry this batch's run
 * id, signed, so a token minted for one batch cannot read another's material
 * or write into its cells.
 *
 * Both act as the person who started the batch -- the token is theirs -- and
 * check again what `AiFillService.start` checked, because a share can be
 * withdrawn and a cell written by somebody else in the minutes a batch runs.
 */
@Injectable()
export class AiFillWorkerService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly rows: DatabaseRowsService,
    private readonly properties: DatabasePropertiesService,
    private readonly fills: AiFillService,
  ) {}

  /**
   * What the model may read for one cell, or why it will not be asked.
   *
   * Marks the cell `running`. A cell the mode no longer lets this batch write
   * (somebody typed a value since the batch started) is skipped here, before
   * any model is paid to answer it.
   */
  async material(runId: string, cellId: string, userId: string): Promise<AiFillMaterial> {
    const cell = await this.requireCell(runId, cellId, userId);
    if (cell.status !== 'QUEUED' && cell.status !== 'RUNNING') {
      return { status: 'unavailable', cellStatus: cellStatusFromColumn(cell.status) };
    }
    if (cell.run.aiRun.status !== 'RUNNING' && cell.run.aiRun.status !== 'PENDING') {
      return this.settle(cell, 'CANCELLED', 'run_ended');
    }

    const context = await this.contextOf(cell.rowId, userId);
    if (
      context === null ||
      !canReadDocument(context.role, context.document, context.workspaceId).allowed
    ) {
      return this.settle(cell, 'FAILED', 'row_unavailable');
    }
    if (!canEditDocument(context.role, context.document).allowed) {
      return this.settle(cell, 'FAILED', 'forbidden');
    }
    const property = cell.property;
    if (!isAiFillableType(property.type)) return this.settle(cell, 'FAILED', 'answer_invalid');

    const row = await this.rows.toRowResponse(cell.run.databaseId, cell.rowId);
    const keep = this.modeKeeps(cell, row);
    if (keep !== null) return this.settle(cell, 'SKIPPED', keep);

    await this.prisma.databaseAiFillCell.update({
      where: { id: cell.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    const run = cell.run;
    const dateConfig = parseDatePropertyConfig(property.config as Record<string, unknown> | null);
    const [properties, content, attachments, members] = await Promise.all([
      run.useProperties ? this.otherValues(row, property.id) : Promise.resolve([]),
      run.useContent ? this.contentOf(cell.rowId) : Promise.resolve(null),
      run.useAttachments ? this.attachmentsOf(cell.rowId, userId) : Promise.resolve([]),
      property.type === 'PERSON' ? this.membersOf(context.workspaceId) : Promise.resolve([]),
    ]);
    const trusted = attachments.every((file) => file.trusted);
    await this.prisma.databaseAiFillCell.update({
      where: { id: cell.id },
      data: { materialTrusted: trusted },
    });

    return {
      status: 'ready',
      instruction: aiFillInstructionText({
        preset: presetFromColumn(run.preset),
        instruction: run.instruction,
        targetLanguage: run.targetLanguage,
      }),
      property: {
        name: property.name,
        type: property.type,
        options: property.options.map((option) => option.label),
        allowNewOptions: run.allowNewOptions,
        isRange: dateConfig.isRange,
        includeTime: dateConfig.includeTime,
      },
      members: members.map((member) => ({
        id: member.id,
        name: member.name ?? member.email,
        email: member.email,
      })),
      row: {
        title: row.document.title,
        properties,
        content: content?.text ?? null,
        contentTruncated: content?.truncated ?? false,
      },
      attachments,
    };
  }

  /**
   * The model's answer for one cell. Checked against the column as it is now,
   * written through the ordinary row write with the batch as its mark, or
   * recorded as the reason it was not.
   */
  async result(
    runId: string,
    cellId: string,
    userId: string,
    request: AiFillCellResultRequest,
  ): Promise<AiFillCellResultResponse> {
    const cell = await this.requireCell(runId, cellId, userId);
    if (cell.status !== 'RUNNING' && cell.status !== 'QUEUED') {
      throw new AppError('ai_fill_finished', 'This cell is no longer being filled');
    }
    if (cell.run.aiRun.status !== 'RUNNING') {
      return this.answer(cell, 'CANCELLED', 'run_ended');
    }
    if (request.outcome === 'failed') return this.answer(cell, 'FAILED', request.errorCode);

    const context = await this.contextOf(cell.rowId, userId);
    if (context === null) return this.answer(cell, 'FAILED', 'row_unavailable');
    if (!canEditDocument(context.role, context.document).allowed) {
      return this.answer(cell, 'FAILED', 'forbidden');
    }
    const row = await this.rows.toRowResponse(cell.run.databaseId, cell.rowId);
    const keep = this.modeKeeps(cell, row);
    if (keep !== null) return this.answer(cell, 'SKIPPED', keep);

    const value = await this.valueFor(cell, userId, context.workspaceId, request.value);
    if (value.kind === 'refused') return this.answer(cell, 'FAILED', value.code);
    if (value.kind === 'nothing') return this.answer(cell, 'EMPTY', null);
    try {
      await this.rows.writeAiValue({
        collectionDocumentId: cell.run.databaseId,
        rowId: cell.rowId,
        value: { propertyId: cell.propertyId, value: value.value },
        aiRunId: runId,
        workspaceId: context.workspaceId,
        correlationId: currentCorrelationId(),
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'validation_failed') {
        return this.answer(cell, 'FAILED', 'answer_invalid');
      }
      throw error;
    }
    return this.answer(cell, 'FILLED', null);
  }

  /**
   * The answer as the value of this cell, checked against the column as it is
   * now, with any option it is allowed to add already added.
   */
  private async valueFor(
    cell: CellRow,
    userId: string,
    workspaceId: string,
    raw: AiFillAnswerValue,
  ): Promise<
    | { kind: 'value'; value: DatabaseRowPropertyValue['value'] }
    | { kind: 'nothing' }
    | { kind: 'refused'; code: AiFillCellErrorCode }
  > {
    const property = await this.prisma.databaseProperty.findUnique({
      where: { id: cell.propertyId },
      include: { options: { orderBy: { orderKey: 'asc' } } },
    });
    if (property === null || !isAiFillableType(property.type)) {
      return { kind: 'refused', code: 'answer_invalid' };
    }
    const dateConfig = parseDatePropertyConfig(property.config as Record<string, unknown> | null);
    const coerced = coerceAiFillAnswer(
      {
        type: property.type,
        isRange: dateConfig.isRange,
        includeTime: dateConfig.includeTime,
        timeZone: dateConfig.timeZone,
        options: property.options,
        members: property.type === 'PERSON' ? await this.membersOf(workspaceId) : [],
        allowNewOptions: cell.run.allowNewOptions,
      },
      raw,
    );
    if (!coerced.ok) return { kind: 'refused', code: coerced.code };
    if (coerced.newOptions.length === 0) {
      return coerced.value === null ? { kind: 'nothing' } : { kind: 'value', value: coerced.value };
    }

    // A new option is a change to the column, not only to the cell: it is
    // made only from the requester's own material (ADR-030, ADR-096), and
    // only by somebody who may change the columns.
    if (cell.materialTrusted !== true) return { kind: 'refused', code: 'option_untrusted' };
    const collection = await this.contextOf(cell.run.databaseId, userId);
    if (
      collection === null ||
      !canManageDatabaseSchema(collection.role, collection.document).allowed
    ) {
      return { kind: 'refused', code: 'option_forbidden' };
    }
    const ids: string[] = [];
    for (const label of coerced.newOptions) {
      const option = await this.properties.createOption({
        propertyId: property.id,
        userId,
        request: { label, color: 'gray' },
        correlationId: currentCorrelationId(),
      });
      ids.push(option.id);
    }
    const existing = Array.isArray(coerced.value) ? coerced.value : [];
    return {
      kind: 'value',
      value: property.type === 'SELECT' ? (ids[0] ?? null) : [...existing, ...ids],
    };
  }

  /** `not_empty` or `not_ai_value` when the batch's mode keeps the cell as it is now. */
  private modeKeeps(cell: CellRow, row: DatabaseRow): AiFillCellErrorCode | null {
    const mode = modeFromColumn(cell.run.mode);
    if (mode === 'replace_all') return null;
    const current = row.values.find((entry) => entry.propertyId === cell.propertyId)?.value;
    if (isEmptyCellValue(current)) return null;
    if (mode === 'empty_only') return 'not_empty';
    const mark = row.aiCells?.find((entry) => entry.propertyId === cell.propertyId);
    return mark?.state === 'filled' ? null : 'not_ai_value';
  }

  private async settle(
    cell: CellRow,
    status: 'FAILED' | 'SKIPPED' | 'CANCELLED',
    errorCode: AiFillCellErrorCode,
  ): Promise<AiFillMaterial> {
    await this.finishCell(cell, status, errorCode);
    return { status: 'unavailable', cellStatus: cellStatusFromColumn(status) };
  }

  private async answer(
    cell: CellRow,
    status: 'FILLED' | 'EMPTY' | 'FAILED' | 'SKIPPED' | 'CANCELLED',
    errorCode: AiFillCellErrorCode | null,
  ): Promise<AiFillCellResultResponse> {
    await this.finishCell(cell, status, errorCode);
    if (status === 'FAILED' || status === 'EMPTY') {
      // A filled cell announces itself as a row change; a failure has no
      // value to carry the news, so the batch's own event does.
      const workspaceId = cell.run.aiRun.workspaceId;
      await this.fills.announce(
        workspaceId,
        cell.run.databaseId,
        cell.aiRunId,
        'running',
        currentCorrelationId(),
      );
    }
    return { status: cellStatusFromColumn(status), errorCode };
  }

  private async finishCell(
    cell: CellRow,
    status: 'FILLED' | 'EMPTY' | 'FAILED' | 'SKIPPED' | 'CANCELLED',
    errorCode: AiFillCellErrorCode | null,
  ): Promise<void> {
    await this.prisma.databaseAiFillCell.update({
      where: { id: cell.id },
      data: { status, errorCode, finishedAt: new Date() },
    });
  }

  /**
   * The cell, after proving the request is this batch's own worker: a service
   * token whose signed run id is this batch, minted for the person who
   * started it.
   */
  private async requireCell(runId: string, cellId: string, userId: string) {
    if (currentAiRunId() !== runId) {
      throw new AppError('ai_fill_worker_only', 'Only the worker of this AI fill may call this');
    }
    const cell = await this.prisma.databaseAiFillCell.findUnique({
      where: { id: cellId },
      include: {
        run: {
          include: {
            aiRun: { select: { status: true, createdById: true, workspaceId: true } },
          },
        },
        property: { include: { options: { orderBy: { orderKey: 'asc' } } } },
      },
    });
    if (cell === null || cell.aiRunId !== runId) throw AppError.notFound('AI fill cell');
    if (cell.run.aiRun.createdById !== userId) {
      throw new AppError('ai_fill_worker_only', 'Only the worker of this AI fill may call this');
    }
    return cell;
  }

  private async contextOf(
    documentId: string,
    userId: string,
  ): Promise<DocumentAccessContext | null> {
    try {
      return await this.access.requireDocumentContext(documentId, userId);
    } catch (error) {
      if (error instanceof AppError) return null;
      throw error;
    }
  }

  /** The row's other values as text, the way a person reads them in the table. */
  private async otherValues(
    row: DatabaseRow,
    propertyId: string,
  ): Promise<{ name: string; value: string }[]> {
    const properties = await this.prisma.databaseProperty.findMany({
      where: { documentId: row.document.parentId ?? '' },
      include: { options: true },
      orderBy: { orderKey: 'asc' },
    });
    const ids = new Set<string>();
    for (const entry of row.values) {
      const type = properties.find((candidate) => candidate.id === entry.propertyId)?.type;
      if ((type === 'PERSON' || type === 'RELATION') && Array.isArray(entry.value)) {
        for (const id of entry.value) ids.add(id);
      }
    }
    const [users, pages] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, name: true, email: true },
      }),
      this.prisma.document.findMany({
        where: { id: { in: [...ids] }, archivedAt: null },
        select: { id: true, title: true },
      }),
    ]);
    const nameOf = new Map<string, string>([
      ...users.map((user): [string, string] => [user.id, user.name ?? user.email]),
      ...pages.map((page): [string, string] => [page.id, page.title]),
    ]);

    const out: { name: string; value: string }[] = [];
    for (const property of properties) {
      if (property.id === propertyId || property.type === 'FILES') continue;
      const value = row.values.find((entry) => entry.propertyId === property.id)?.value;
      if (isEmptyCellValue(value)) continue;
      const labels = new Map(property.options.map((option) => [option.id, option.label]));
      const text = valueText(value ?? null, (id) => labels.get(id) ?? nameOf.get(id) ?? null);
      if (text.length > 0)
        out.push({ name: property.name, value: text.slice(0, PROPERTY_VALUE_MAX_CHARS) });
    }
    return out;
  }

  private async contentOf(rowId: string): Promise<{ text: string; truncated: boolean } | null> {
    const content = await this.prisma.documentContent.findUnique({
      where: { documentId: rowId },
      select: { markdown: true },
    });
    const text = content?.markdown?.trim() ?? '';
    if (text.length === 0) return null;
    return {
      text: text.slice(0, CONTENT_MAX_CHARS),
      truncated: text.length > CONTENT_MAX_CHARS,
    };
  }

  /**
   * The row's files: what was uploaded onto its page, the files of its FILES
   * cells among them (ADR-098). A reader of the row may read them; whether
   * each counts as the reader's own is `attachmentTrustFor`, as everywhere.
   */
  private async attachmentsOf(
    rowId: string,
    userId: string,
  ): Promise<
    {
      filename: string;
      mimeType: string;
      text: string | null;
      truncated: boolean;
      trusted: boolean;
    }[]
  > {
    const files = await this.prisma.attachment.findMany({
      where: { documentId: rowId, deletedAt: null, conversationId: null, isCover: false },
      orderBy: { createdAt: 'asc' },
      take: ATTACHMENTS_MAX,
      select: {
        filename: true,
        mimeType: true,
        createdById: true,
        extractedText: true,
        correctedText: true,
        textCorrectedById: true,
        imageDescription: true,
        fetchedFromUrl: true,
        screening: true,
      },
    });
    let budget = ATTACHMENTS_TOTAL_MAX_CHARS;
    return files.map((file) => {
      const full = (file.correctedText ?? file.extractedText ?? file.imageDescription ?? '').trim();
      const allowed = Math.max(0, Math.min(ATTACHMENT_MAX_CHARS, budget));
      const text = full.length === 0 ? null : full.slice(0, allowed);
      budget -= text?.length ?? 0;
      const trust = attachmentTrustFor({
        createdById: file.createdById,
        readerId: userId,
        correctedById: file.correctedText === null ? null : file.textCorrectedById,
        fetchedFromUrl: file.fetchedFromUrl,
        screening: screeningFromColumn(file.screening),
      });
      return {
        filename: file.filename,
        mimeType: file.mimeType,
        text,
        truncated: text !== null && text.length < full.length,
        trusted: trust.trusted,
      };
    });
  }

  private async membersOf(
    workspaceId: string,
  ): Promise<{ id: string; name: string | null; email: string }[]> {
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: { user: { select: { id: true, name: true, email: true } } },
      take: MEMBERS_MAX,
    });
    return members.map((member) => member.user);
  }
}

function valueText(
  value: DatabaseRowPropertyValue['value'],
  label: (id: string) => string | null,
): string {
  if (value === null) return '';
  if (typeof value === 'string') return label(value) ?? value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((id) => label(id))
      .filter((entry): entry is string => entry !== null)
      .join(', ');
  }
  return value.end === null ? value.start : `${value.start} bis ${value.end}`;
}
