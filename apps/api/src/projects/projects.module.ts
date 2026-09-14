import { Module } from '@nestjs/common';

import { AttachmentsModule } from '../attachments/attachments.module';
import { OutboxService } from '../common/outbox.service';

import { ProjectBridgeService } from './project-bridge.service';
import { ProjectBuildsService } from './project-builds.service';
import {
  ProjectBuildsController,
  ProjectsController,
  WorkspaceProjectsController,
} from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * Project workspaces (issue #43, ADR-027).
 *
 * Nothing here compiles anything and nothing here writes Yjs state: the module
 * writes rows, hands file operations to the collaboration server and enqueues
 * builds. TeX Live lives in a container the worker starts (CLAUDE.md rule 6).
 */
@Module({
  // For the attachments a build produced: deleting one goes through the service
  // that owns the stored objects, never through Prisma here.
  imports: [AttachmentsModule],
  controllers: [WorkspaceProjectsController, ProjectsController, ProjectBuildsController],
  providers: [ProjectsService, ProjectBuildsService, ProjectBridgeService, OutboxService],
  exports: [ProjectsService, ProjectBuildsService],
})
export class ProjectsModule {}
