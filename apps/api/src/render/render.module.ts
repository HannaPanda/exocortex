import { Module } from '@nestjs/common';

import {
  DocumentRenderController,
  RenderController,
  WorkspaceRenderController,
} from './render.controller';
import { RenderJobsService } from './render-jobs.service';
import { RenderTemplatesService } from './render-templates.service';

/**
 * Rendering pages into files (issue #44, ADR-026).
 *
 * Nothing here builds anything: the module writes rows and enqueues jobs, and
 * Pandoc and TeX Live live in a container the worker starts (CLAUDE.md rule 6).
 */
@Module({
  controllers: [WorkspaceRenderController, RenderController, DocumentRenderController],
  providers: [RenderTemplatesService, RenderJobsService],
  exports: [RenderTemplatesService, RenderJobsService],
})
export class RenderModule {}
