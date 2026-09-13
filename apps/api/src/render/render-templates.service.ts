import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canManageRenderTemplates,
  canReadWorkspace,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type CreateRenderTemplateRequest,
  type RenderTemplate,
  type RenderTemplateListResponse,
  type UpdateRenderTemplateRequest,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';

import { mapRenderTemplate, RENDER_TEMPLATE_SELECT } from './render-mapper';

/**
 * The ways a workspace turns pages into files (issue #44, ADR-026).
 *
 * A template is Pandoc's template language and nothing of ours. The service
 * therefore validates almost nothing about the body: a LaTeX preamble that
 * does not compile is a build failure with a log, not a rejected form, and
 * pretending to know in advance which `\usepackage` lines the container has
 * would be a lie that goes stale with the image.
 */
@Injectable()
export class RenderTemplatesService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly access: WorkspaceAccessService,
    private readonly settings: SettingsService,
  ) {}

  async list(workspaceId: string, userId: string): Promise<RenderTemplateListResponse> {
    const role = await this.access.findRole(workspaceId, userId);
    assertPolicy(canReadWorkspace(role));

    const [rows, settings] = await Promise.all([
      this.prisma.renderTemplate.findMany({
        where: { workspaceId },
        select: RENDER_TEMPLATE_SELECT,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      this.settings.getForWorkspace(workspaceId),
    ]);

    return {
      templates: rows.map(mapRenderTemplate),
      enabledForWorkspace: settings['render.enabled'],
    };
  }

  async read(templateId: string, userId: string): Promise<RenderTemplate> {
    const row = await this.prisma.renderTemplate.findUnique({
      where: { id: templateId },
      select: RENDER_TEMPLATE_SELECT,
    });
    if (row === null) throw AppError.notFound('Render template');
    await this.access.requireRole(row.workspaceId, userId);
    return mapRenderTemplate(row);
  }

  async create(input: {
    workspaceId: string;
    userId: string;
    request: CreateRenderTemplateRequest;
  }): Promise<RenderTemplate> {
    const role = await this.access.findRole(input.workspaceId, input.userId);
    assertPolicy(canManageRenderTemplates(role));
    assertVariableNamesUnique(input.request.variables);

    const row = await this.prisma.renderTemplate.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.request.name,
        description: input.request.description,
        renderer: input.request.renderer,
        source: input.request.source,
        variables: input.request.variables as unknown as Prisma.InputJsonValue,
        createdById: input.userId,
      },
      select: RENDER_TEMPLATE_SELECT,
    });
    return mapRenderTemplate(row);
  }

  async update(input: {
    templateId: string;
    userId: string;
    request: UpdateRenderTemplateRequest;
  }): Promise<RenderTemplate> {
    const existing = await this.prisma.renderTemplate.findUnique({
      where: { id: input.templateId },
      select: { workspaceId: true },
    });
    if (existing === null) throw AppError.notFound('Render template');

    const role = await this.access.findRole(existing.workspaceId, input.userId);
    assertPolicy(canManageRenderTemplates(role));
    if (input.request.variables !== undefined) {
      assertVariableNamesUnique(input.request.variables);
    }

    const row = await this.prisma.renderTemplate.update({
      where: { id: input.templateId },
      data: {
        name: input.request.name,
        description: input.request.description,
        renderer: input.request.renderer,
        // `null` is a value here (use the built-in template), so `undefined`
        // alone may mean "leave it alone".
        source: input.request.source === undefined ? undefined : input.request.source,
        variables:
          input.request.variables === undefined
            ? undefined
            : (input.request.variables as unknown as Prisma.InputJsonValue),
      },
      select: RENDER_TEMPLATE_SELECT,
    });
    return mapRenderTemplate(row);
  }

  /**
   * Deletes a template. The jobs built from it stay, with their artifacts and
   * their name copied onto them: what an existing PDF was made from is exactly
   * the question somebody asks about it later.
   */
  async remove(templateId: string, userId: string): Promise<void> {
    const existing = await this.prisma.renderTemplate.findUnique({
      where: { id: templateId },
      select: { workspaceId: true },
    });
    if (existing === null) throw AppError.notFound('Render template');

    const role = await this.access.findRole(existing.workspaceId, userId);
    assertPolicy(canManageRenderTemplates(role));

    await this.prisma.renderTemplate.delete({ where: { id: templateId } });
  }
}

/**
 * Two variables of the same name would produce a form with two fields feeding
 * one `$name$`, and whichever of them the resolver happened to write last would
 * win. Refused rather than deduplicated: the author meant two different things.
 */
function assertVariableNamesUnique(variables: readonly { name: string }[]): void {
  const seen = new Set<string>();
  for (const variable of variables) {
    if (seen.has(variable.name)) {
      throw AppError.validation(`Variable "${variable.name}" ist doppelt vergeben`);
    }
    seen.add(variable.name);
  }
}
