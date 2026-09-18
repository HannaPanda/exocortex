import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canCreateDocument,
  canEditDocument,
  canReadDocument,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type CreateTemplateRequest,
  type DeleteTemplateResponse,
  type DocumentTemplate,
  type InstantiateTemplateRequest,
  type InstantiateTemplateResponse,
  type TemplateListResponse,
  type TemplateResponse,
  titleForCopy,
  type UpdateTemplateRequest,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import {
  copyDocumentForNewPage,
  proseMirrorJsonToYjsState,
  yjsStateToProseMirrorJson,
} from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { LOGGER } from '../common/logger.provider';
import {
  DOCUMENT_SELECT,
  type DocumentRow,
  toIconColor,
  toSummary,
} from '../documents/document-shape';
import { DocumentsService } from '../documents/documents.service';
import { PRISMA } from '../platform/platform.module';
import { SettingsService } from '../platform/settings.service';

/**
 * Page templates (issue #79, ADR-039).
 *
 * Everything here is a copy, never a link. A page made from a template knows
 * nothing about the template afterwards and the template knows nothing about
 * it: that is the whole contract, and it is what keeps this feature from
 * growing into a second collaborative state that would have to be kept in sync
 * with the pages derived from it.
 */

interface TemplateRow {
  documentId: string;
  description: string | null;
  titlePattern: string | null;
  targetParentId: string | null;
  useCount: number;
  lastUsedAt: Date | null;
  document: DocumentRow;
  targetParent: DocumentRow | null;
}

const TEMPLATE_INCLUDE = {
  document: { select: DOCUMENT_SELECT },
  targetParent: { select: DOCUMENT_SELECT },
} as const;

function toTemplate(row: TemplateRow): DocumentTemplate {
  return {
    document: toSummary(row.document),
    description: row.description,
    titlePattern: row.titlePattern,
    targetParent: row.targetParent === null ? null : toSummary(row.targetParent),
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class TemplatesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly documents: DocumentsService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * The templates of a workspace, the useful ones first.
   *
   * Recently used before never used, and alphabetical within each group. A
   * picker sorted purely by name makes somebody scroll past five templates
   * they have never opened to reach the one they use every Monday; sorting
   * purely by use hides the new one somebody just made.
   */
  async list(input: { workspaceId: string; userId: string }): Promise<TemplateListResponse> {
    await this.access.requireRole(input.workspaceId, input.userId);

    const rows = await this.prisma.documentTemplate.findMany({
      where: { document: { workspaceId: input.workspaceId, archivedAt: null } },
      include: TEMPLATE_INCLUDE,
      orderBy: [{ lastUsedAt: 'desc' }, { document: { title: 'asc' } }],
    });

    return { templates: rows.map(toTemplate) };
  }

  /**
   * Turning a page into a template.
   *
   * The page stays where it is and stays what it is. A workspace that wants
   * its templates in one place makes a page for them and moves them under it,
   * the same way it would organise anything else -- a hidden shelf that only
   * templates live on would be a second kind of place in a product whose whole
   * structure is "pages under pages".
   */
  async create(input: {
    workspaceId: string;
    userId: string;
    request: CreateTemplateRequest;
  }): Promise<TemplateResponse> {
    const context = await this.access.requireDocumentContext(
      input.request.documentId,
      input.userId,
    );
    assertPolicy(canEditDocument(context.role, context.document));

    if (context.workspaceId !== input.workspaceId) {
      throw new AppError('document_cross_workspace', 'The page belongs to a different workspace');
    }
    if (context.document.type !== 'PAGE') {
      throw new AppError(
        'template_not_a_page',
        'Only an ordinary page can be a template, not a database or a project',
      );
    }

    const existing = await this.prisma.documentTemplate.findUnique({
      where: { documentId: input.request.documentId },
      select: { documentId: true },
    });
    if (existing !== null) throw new AppError('template_exists', 'This page is already a template');

    await this.assertUsableTarget(input.request.targetParentId ?? null, input.workspaceId);

    const row = await this.prisma.documentTemplate.create({
      data: {
        documentId: input.request.documentId,
        description: input.request.description ?? null,
        titlePattern: input.request.titlePattern ?? null,
        targetParentId: input.request.targetParentId ?? null,
      },
      include: TEMPLATE_INCLUDE,
    });

    this.logger.info('Page marked as a template', {
      documentId: input.request.documentId,
      workspaceId: input.workspaceId,
    });
    return { template: toTemplate(row) };
  }

  async update(input: {
    documentId: string;
    userId: string;
    request: UpdateTemplateRequest;
  }): Promise<TemplateResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));
    await this.loadOrThrow(input.documentId);

    if (input.request.targetParentId !== undefined) {
      await this.assertUsableTarget(input.request.targetParentId, context.workspaceId);
    }

    const row = await this.prisma.documentTemplate.update({
      where: { documentId: input.documentId },
      data: {
        ...(input.request.description === undefined
          ? {}
          : { description: input.request.description }),
        ...(input.request.titlePattern === undefined
          ? {}
          : { titlePattern: input.request.titlePattern }),
        ...(input.request.targetParentId === undefined
          ? {}
          : { targetParentId: input.request.targetParentId }),
      },
      include: TEMPLATE_INCLUDE,
    });
    return { template: toTemplate(row) };
  }

  /**
   * Unmarking. The page survives: deleting a template is deleting the mark,
   * and a caller who meant the page has `exo_page_trash` for that.
   */
  async remove(input: { documentId: string; userId: string }): Promise<DeleteTemplateResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));
    await this.loadOrThrow(input.documentId);

    await this.prisma.documentTemplate.delete({ where: { documentId: input.documentId } });
    this.logger.info('Template mark removed', {
      documentId: input.documentId,
      workspaceId: context.workspaceId,
    });
    return { deleted: true };
  }

  /**
   * Using a template: a new page that holds a copy of its content.
   *
   * The copy is built from the template's canonical Yjs state rather than from
   * its Markdown, because Markdown is an interchange format (ADR-007) and
   * would quietly drop the database embeds, the callouts and the columns that
   * are half the reason to have a template at all. The new page is created
   * with that state in hand, which is only sound because the page does not
   * exist yet (see `DocumentsService.create`).
   */
  async instantiate(input: {
    documentId: string;
    userId: string;
    request: InstantiateTemplateRequest;
    correlationId: string;
  }): Promise<InstantiateTemplateResponse> {
    const context = await this.access.requireDocumentContext(input.documentId, input.userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));
    assertPolicy(canCreateDocument(context.role));

    const template = await this.loadOrThrow(input.documentId);
    const warnings: string[] = [];

    const parentId =
      input.request.parentId !== undefined ? input.request.parentId : template.targetParentId;
    const parent = parentId === null ? null : await this.loadParent(parentId, context.workspaceId);

    // The workspace's own zone, because `{{datum}}` means the date of the
    // person creating the page and the server runs in UTC.
    const settings = await this.settings.getForWorkspace(context.workspaceId);
    const title = titleForCopy({
      pattern: template.titlePattern,
      templateTitle: template.document.title,
      requestedTitle: input.request.title ?? null,
      now: new Date(),
      timeZone: settings['calendar.timeZone'],
    });

    const content = await this.prisma.documentContent.findUnique({
      where: { documentId: input.documentId },
      select: { yjsState: true },
    });
    if (content === null) throw AppError.notFound('Document content');

    const copy = copyDocumentForNewPage(yjsStateToProseMirrorJson(content.yjsState));
    if (copy.attachmentIds.length > 0) {
      warnings.push(
        'Die Kopie verweist auf die Dateien der Vorlage. Wird die Vorlage gelöscht, fehlen sie.',
      );
    }
    if (copy.embeddedDatabaseIds.length > 0) {
      warnings.push('Eingebettete Datenbanken zeigen in der Kopie auf dieselbe Datenbank.');
    }

    const iconColor = toIconColor(template.document.iconColor);
    const created = await this.documents.create({
      workspaceId: context.workspaceId,
      userId: input.userId,
      request: {
        type: 'PAGE',
        title,
        parentId,
        ...(template.document.icon === null ? {} : { icon: template.document.icon }),
        ...(iconColor === null ? {} : { iconColor }),
        ...(input.request.afterSiblingId === undefined
          ? {}
          : { afterSiblingId: input.request.afterSiblingId }),
        ...(input.request.beforeSiblingId === undefined
          ? {}
          : { beforeSiblingId: input.request.beforeSiblingId }),
      },
      correlationId: input.correlationId,
      initialYjsState: proseMirrorJsonToYjsState(copy.document),
    });

    // The cover is a second request because it is a reference to an
    // attachment, and `documents.update` is the one place that checks whether
    // the attachment may be used as one.
    if (template.document.coverAttachmentId !== null) {
      await this.documents.update({
        documentId: created.id,
        userId: input.userId,
        request: {
          coverAttachmentId: template.document.coverAttachmentId,
          coverPosition: template.document.coverPosition,
        },
        correlationId: input.correlationId,
      });
    }

    const copiedProperties = await this.copyProperties({
      templateId: input.documentId,
      templateParentId: template.document.parentId,
      newDocumentId: created.id,
      parent,
      warnings,
    });

    await this.prisma.documentTemplate.update({
      where: { documentId: input.documentId },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    });

    this.logger.info('Page created from a template', {
      templateId: input.documentId,
      documentId: created.id,
      workspaceId: context.workspaceId,
      parentId,
      copiedProperties,
      correlationId: input.correlationId,
    });

    return {
      document: created,
      parent: parent === null ? null : toSummary(parent),
      copiedProperties,
      warnings,
    };
  }

  /**
   * Carrying the row properties over.
   *
   * Only within one database. A property value names a `DatabaseProperty` of
   * one collection, so copying it anywhere else would either point at a column
   * that does not exist there or silently match one by name -- and matching by
   * name is exactly the kind of guess that puts the wrong date in the wrong
   * field. When the target is a different database, the copy is made without
   * its properties and the caller is told so.
   */
  private async copyProperties(input: {
    templateId: string;
    templateParentId: string | null;
    newDocumentId: string;
    parent: DocumentRow | null;
    warnings: string[];
  }): Promise<number> {
    if (input.parent === null || input.parent.type !== 'COLLECTION') return 0;

    const values = await this.prisma.documentPropertyValue.findMany({
      where: { documentId: input.templateId },
    });
    if (values.length === 0) return 0;

    if (input.templateParentId !== input.parent.id) {
      input.warnings.push(
        'Die Eigenschaften der Vorlage gehören zu einer anderen Datenbank und wurden nicht übernommen.',
      );
      return 0;
    }

    await this.prisma.documentPropertyValue.createMany({
      data: values.map((value) => ({
        documentId: input.newDocumentId,
        propertyId: value.propertyId,
        textValue: value.textValue,
        numberValue: value.numberValue,
        boolValue: value.boolValue,
        dateValue: value.dateValue,
        dateEndValue: value.dateEndValue,
        dateAllDay: value.dateAllDay,
        jsonValue: value.jsonValue ?? undefined,
      })),
    });
    return values.length;
  }

  private async loadOrThrow(documentId: string): Promise<TemplateRow> {
    const row = await this.prisma.documentTemplate.findUnique({
      where: { documentId },
      include: TEMPLATE_INCLUDE,
    });
    if (row === null) throw AppError.notFound('Template');
    return row;
  }

  private async loadParent(parentId: string, workspaceId: string): Promise<DocumentRow> {
    const parent = await this.prisma.document.findUnique({
      where: { id: parentId },
      select: DOCUMENT_SELECT,
    });
    if (parent === null || parent.workspaceId !== workspaceId) {
      throw AppError.notFound('Parent document');
    }
    if (parent.archivedAt !== null) {
      throw new AppError('document_archived', 'Cannot create a page under an archived parent');
    }
    return parent;
  }

  /** A suggested target has to be a page in this workspace, or nothing. */
  private async assertUsableTarget(
    targetParentId: string | null,
    workspaceId: string,
  ): Promise<void> {
    if (targetParentId === null) return;
    await this.loadParent(targetParentId, workspaceId);
  }
}
