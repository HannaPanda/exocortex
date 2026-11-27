import { Inject, Injectable } from '@nestjs/common';

import { assertPolicy, canManageDatabaseSchema, WorkspaceAccessService } from '@exocortex/auth';
import {
  aiFillConfigProblems,
  type DatabaseProperty,
  type SetDatabasePropertyAiRequest,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';

import { AppError } from '../../common/app-error';
import { PRISMA } from '../../platform/platform.module';
import { RealtimeService } from '../../realtime/realtime.service';
import { listDatabaseProperties } from '../database-properties.service';

import {
  autoFillFromColumn,
  autoFillToColumn,
  presetFromColumn,
  presetToColumn,
} from './ai-fill-mapper';

/**
 * A column's AI instruction (issue #237, ADR-099): written by whoever may
 * change the database's columns, because it is part of what the column is.
 *
 * Writing it starts nothing. A fill is a separate request, and a column that
 * fills itself (`autoFill`) runs as the account that wrote the instruction
 * last, so the person who decided that it should run is the one whose rights
 * it reads with.
 */
@Injectable()
export class AiFillConfigService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly realtime: RealtimeService,
  ) {}

  async set(input: {
    collectionDocumentId: string;
    propertyId: string;
    userId: string;
    request: SetDatabasePropertyAiRequest;
    correlationId: string;
  }): Promise<DatabaseProperty> {
    const { property, workspaceId } = await this.requireProperty(input);
    const request = input.request;
    const current = await this.prisma.databasePropertyAi.findUnique({
      where: { propertyId: property.id },
    });

    const merged = mergeInstruction(request, current);
    const problems = aiFillConfigProblems(property.type, merged);
    if (problems.length > 0) {
      throw new AppError(
        'database_property_ai_invalid',
        `The AI instruction does not fit this column: ${problems.join(', ')}`,
        { reason: problems[0], problems },
      );
    }

    const data = {
      ...merged,
      preset: presetToColumn(merged.preset),
      autoFill: autoFillToColumn(merged.autoFill),
      updatedById: input.userId,
    };
    await this.prisma.databasePropertyAi.upsert({
      where: { propertyId: property.id },
      create: { propertyId: property.id, ...data },
      update: data,
    });

    return this.answer(input, workspaceId);
  }

  async remove(input: {
    collectionDocumentId: string;
    propertyId: string;
    userId: string;
    correlationId: string;
  }): Promise<DatabaseProperty> {
    const { property, workspaceId } = await this.requireProperty(input);
    await this.prisma.databasePropertyAi.deleteMany({ where: { propertyId: property.id } });
    return this.answer(input, workspaceId);
  }

  private async answer(
    input: { collectionDocumentId: string; propertyId: string; correlationId: string },
    workspaceId: string,
  ): Promise<DatabaseProperty> {
    await this.realtime.emit('database.property.changed', workspaceId, input.correlationId, {
      documentId: input.collectionDocumentId,
    });
    const properties = await listDatabaseProperties(this.prisma, input.collectionDocumentId);
    const updated = properties.find((entry) => entry.id === input.propertyId);
    if (updated === undefined) throw AppError.notFound('Database property');
    return updated;
  }

  private async requireProperty(input: {
    collectionDocumentId: string;
    propertyId: string;
    userId: string;
  }) {
    const context = await this.access.requireDocumentContext(
      input.collectionDocumentId,
      input.userId,
    );
    if (context.document.type !== 'COLLECTION') {
      throw AppError.validation('Document is not a database');
    }
    assertPolicy(canManageDatabaseSchema(context.role, context.document));
    const property = await this.prisma.databaseProperty.findUnique({
      where: { id: input.propertyId },
      select: { id: true, documentId: true, type: true },
    });
    if (property === null || property.documentId !== input.collectionDocumentId) {
      throw AppError.notFound('Database property');
    }
    return { property, workspaceId: context.workspaceId };
  }
}

type StoredInstruction = Prisma.DatabasePropertyAiGetPayload<object>;

/**
 * The instruction a request leaves the column with. A field the request does
 * not name keeps what the column already says, so an agent that only switches
 * `autoFill` on does not reset the sources it never mentioned.
 */
function mergeInstruction(
  request: SetDatabasePropertyAiRequest,
  current: StoredInstruction | null,
) {
  const preset =
    request.preset ?? (current === null ? undefined : presetFromColumn(current.preset));
  if (preset === undefined) {
    throw AppError.validation('A column without an AI instruction needs a preset');
  }
  const keep = <T>(next: T | undefined, stored: T | undefined, fallback: T): T =>
    next ?? stored ?? fallback;
  return {
    preset,
    instruction: emptyToNull(
      request.instruction === undefined ? current?.instruction : request.instruction,
    ),
    targetLanguage:
      preset === 'translate'
        ? emptyToNull(
            request.targetLanguage === undefined ? current?.targetLanguage : request.targetLanguage,
          )
        : null,
    allowNewOptions: keep(request.allowNewOptions, current?.allowNewOptions, false),
    useContent: keep(request.useContent, current?.useContent, true),
    useProperties: keep(request.useProperties, current?.useProperties, true),
    useAttachments: keep(request.useAttachments, current?.useAttachments, true),
    autoFill: keep(
      request.autoFill,
      current === null ? undefined : autoFillFromColumn(current.autoFill),
      'off',
    ),
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
