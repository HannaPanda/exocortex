import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { type VerifiedSession } from '@exocortex/auth';
import {
  type AddProjectAssetRequest,
  addProjectAssetRequestSchema,
  type CreateProjectRequest,
  createProjectRequestSchema,
  type DeleteProjectBuildResponse,
  deleteProjectBuildResponseSchema,
  type DeleteProjectFileRequest,
  deleteProjectFileRequestSchema,
  type MoveProjectFileRequest,
  moveProjectFileRequestSchema,
  type PatchProjectFileRequest,
  patchProjectFileRequestSchema,
  type ProjectBuildArtifactsResponse,
  projectBuildArtifactsResponseSchema,
  type ProjectBuildDiagnosticsResponse,
  projectBuildDiagnosticsResponseSchema,
  type ProjectBuildListResponse,
  projectBuildListResponseSchema,
  type ProjectBuildLogResponse,
  projectBuildLogResponseSchema,
  type ProjectBuildResponse,
  projectBuildResponseSchema,
  type ProjectFileContentResponse,
  projectFileContentResponseSchema,
  type ProjectFileListResponse,
  projectFileListResponseSchema,
  type ProjectListResponse,
  projectListResponseSchema,
  type ProjectMutationResponse,
  projectMutationResponseSchema,
  type ProjectResponse,
  projectResponseSchema,
  type StartProjectBuildRequest,
  startProjectBuildRequestSchema,
  type StartProjectBuildResponse,
  startProjectBuildResponseSchema,
  type UpdateProjectRequest,
  updateProjectRequestSchema,
  type WriteProjectFileRequest,
  writeProjectFileRequestSchema,
} from '@exocortex/contracts';

import { CurrentSession } from '../auth/session.guard';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { ProjectBuildsService } from './project-builds.service';
import { ProjectsService } from './projects.service';

/**
 * The projects of one workspace (issue #43, ADR-027).
 *
 * There is no delete route here, and that is not an omission: a project *is* a
 * document, so `DELETE /api/documents/:id` and the trash already remove one,
 * for the browser, the built-in AI and MCP alike. A second delete would be a
 * second set of trash semantics to keep in step.
 */
@ApiTags('workspaces')
@Controller('api/workspaces/:workspaceId/projects')
export class WorkspaceProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly builds: ProjectBuildsService,
  ) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(projectListResponseSchema) })
  async list(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
  ): Promise<ProjectListResponse> {
    return this.projects.list(workspaceId, session.userId);
  }

  @Post()
  @ApiBody({ schema: openApiSchema(createProjectRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(projectResponseSchema) })
  async create(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Body(zodPipe(createProjectRequestSchema)) body: CreateProjectRequest,
  ): Promise<ProjectResponse> {
    return {
      project: await this.projects.create({ workspaceId, userId: session.userId, request: body }),
    };
  }

  @Get('builds')
  @ApiOkResponse({ schema: openApiResponseSchema(projectBuildListResponseSchema) })
  async listBuilds(
    @CurrentSession() session: VerifiedSession,
    @Param('workspaceId') workspaceId: string,
    @Query('projectId') projectId?: string,
  ): Promise<ProjectBuildListResponse> {
    return this.builds.list({ workspaceId, userId: session.userId, projectId });
  }
}

/** One project: its settings, its files and its builds. */
@ApiTags('projects')
@Controller('api/projects/:projectId')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly builds: ProjectBuildsService,
  ) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(projectResponseSchema) })
  async read(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
  ): Promise<ProjectResponse> {
    return { project: await this.projects.read(projectId, session.userId) };
  }

  @Patch()
  @ApiBody({ schema: openApiSchema(updateProjectRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(projectResponseSchema) })
  async update(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
    @Body(zodPipe(updateProjectRequestSchema)) body: UpdateProjectRequest,
  ): Promise<ProjectResponse> {
    return {
      project: await this.projects.update({ projectId, userId: session.userId, request: body }),
    };
  }

  @Get('files')
  @ApiOkResponse({ schema: openApiResponseSchema(projectFileListResponseSchema) })
  async listFiles(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
  ): Promise<ProjectFileListResponse> {
    return this.projects.listFiles(projectId, session.userId);
  }

  /**
   * One file's content.
   *
   * The path travels as a query parameter rather than in the URL: a project
   * path contains slashes, and a route parameter that has to be encoded and
   * decoded around them is a route parameter somebody eventually gets wrong.
   */
  @Get('file')
  @ApiOkResponse({ schema: openApiResponseSchema(projectFileContentResponseSchema) })
  async readFile(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
    @Query('path') path: string,
  ): Promise<ProjectFileContentResponse> {
    return this.projects.readFile(projectId, session.userId, path ?? '');
  }

  @Post('files')
  @ApiBody({ schema: openApiSchema(writeProjectFileRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(projectMutationResponseSchema) })
  async writeFile(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
    @Body(zodPipe(writeProjectFileRequestSchema)) body: WriteProjectFileRequest,
  ): Promise<ProjectMutationResponse> {
    return this.projects.writeFile({ projectId, userId: session.userId, request: body });
  }

  @Post('files/patch')
  @ApiBody({ schema: openApiSchema(patchProjectFileRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(projectMutationResponseSchema) })
  async patchFile(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
    @Body(zodPipe(patchProjectFileRequestSchema)) body: PatchProjectFileRequest,
  ): Promise<ProjectMutationResponse> {
    return this.projects.patchFile({ projectId, userId: session.userId, request: body });
  }

  @Post('files/move')
  @ApiBody({ schema: openApiSchema(moveProjectFileRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(projectMutationResponseSchema) })
  async moveFile(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
    @Body(zodPipe(moveProjectFileRequestSchema)) body: MoveProjectFileRequest,
  ): Promise<ProjectMutationResponse> {
    return this.projects.moveFile({ projectId, userId: session.userId, request: body });
  }

  @Delete('files')
  @ApiBody({ schema: openApiSchema(deleteProjectFileRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(projectMutationResponseSchema) })
  async deleteFile(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
    @Body(zodPipe(deleteProjectFileRequestSchema)) body: DeleteProjectFileRequest,
  ): Promise<ProjectMutationResponse> {
    return this.projects.deleteFile({ projectId, userId: session.userId, request: body });
  }

  @Post('assets')
  @ApiBody({ schema: openApiSchema(addProjectAssetRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(projectMutationResponseSchema) })
  async addAsset(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
    @Body(zodPipe(addProjectAssetRequestSchema)) body: AddProjectAssetRequest,
  ): Promise<ProjectMutationResponse> {
    return this.projects.addAsset({ projectId, userId: session.userId, request: body });
  }

  @Post('builds')
  @ApiBody({ schema: openApiSchema(startProjectBuildRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(startProjectBuildResponseSchema) })
  async startBuild(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
    @Body(zodPipe(startProjectBuildRequestSchema)) body: StartProjectBuildRequest,
  ): Promise<StartProjectBuildResponse> {
    return this.builds.start({ projectId, userId: session.userId, request: body });
  }
}

/** One build, from either surface. */
@ApiTags('projects')
@Controller('api/project-builds/:buildId')
export class ProjectBuildsController {
  constructor(private readonly builds: ProjectBuildsService) {}

  @Get()
  @ApiOkResponse({ schema: openApiResponseSchema(projectBuildResponseSchema) })
  async read(
    @CurrentSession() session: VerifiedSession,
    @Param('buildId') buildId: string,
  ): Promise<ProjectBuildResponse> {
    return { build: await this.builds.read(buildId, session.userId) };
  }

  @Get('log')
  @ApiOkResponse({ schema: openApiResponseSchema(projectBuildLogResponseSchema) })
  async log(
    @CurrentSession() session: VerifiedSession,
    @Param('buildId') buildId: string,
  ): Promise<ProjectBuildLogResponse> {
    return this.builds.readLog(buildId, session.userId);
  }

  @Get('diagnostics')
  @ApiOkResponse({ schema: openApiResponseSchema(projectBuildDiagnosticsResponseSchema) })
  async diagnostics(
    @CurrentSession() session: VerifiedSession,
    @Param('buildId') buildId: string,
  ): Promise<ProjectBuildDiagnosticsResponse> {
    return this.builds.readDiagnostics(buildId, session.userId);
  }

  @Get('artifacts')
  @ApiOkResponse({ schema: openApiResponseSchema(projectBuildArtifactsResponseSchema) })
  async artifacts(
    @CurrentSession() session: VerifiedSession,
    @Param('buildId') buildId: string,
  ): Promise<ProjectBuildArtifactsResponse> {
    return this.builds.artifacts(buildId, session.userId);
  }

  @Delete()
  @ApiOkResponse({ schema: openApiResponseSchema(deleteProjectBuildResponseSchema) })
  async remove(
    @CurrentSession() session: VerifiedSession,
    @Param('buildId') buildId: string,
  ): Promise<DeleteProjectBuildResponse> {
    await this.builds.remove(buildId, session.userId);
    return { deleted: true };
  }

  @Post('cancel')
  @ApiOkResponse({ schema: openApiResponseSchema(projectBuildResponseSchema) })
  async cancel(
    @CurrentSession() session: VerifiedSession,
    @Param('buildId') buildId: string,
  ): Promise<ProjectBuildResponse> {
    return { build: await this.builds.cancel(buildId, session.userId) };
  }
}
