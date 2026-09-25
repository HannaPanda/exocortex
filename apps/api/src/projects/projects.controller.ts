import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
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
  type ExportProjectResponse,
  exportProjectResponseSchema,
  type ImportProjectRequest,
  importProjectRequestSchema,
  type ImportProjectResponse,
  importProjectResponseSchema,
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
  type ProjectPositionLookupResponse,
  projectPositionLookupResponseSchema,
  type ProjectResponse,
  projectResponseSchema,
  type ProjectSourceLookupResponse,
  projectSourceLookupResponseSchema,
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
import { AppError } from '../common/app-error';
import { type ReaderLocaleHeaders } from '../common/reader-locale';
import { openApiResponseSchema, openApiSchema, zodPipe } from '../common/zod';

import { ProjectArchiveService } from './project-archive.service';
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
    @Headers() headers: ReaderLocaleHeaders,
    @Query('projectId') projectId?: string,
  ): Promise<ProjectBuildListResponse> {
    return this.builds.list({ workspaceId, userId: session.userId, projectId, headers });
  }
}

/** One project: its settings, its files and its builds. */
@ApiTags('projects')
@Controller('api/projects/:projectId')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly builds: ProjectBuildsService,
    private readonly archive: ProjectArchiveService,
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

  /**
   * Reads a `.zip` that was uploaded as an attachment into the file tree
   * (issue #54).
   *
   * The bytes arrive as an attachment rather than as a multipart body here, for
   * the reason `POST assets` takes an id: the upload route owns the size limit,
   * the magic-byte sniff and the quota, and it means the browser and an agent
   * take the same two steps instead of two different ones.
   */
  @Post('import')
  @ApiBody({ schema: openApiSchema(importProjectRequestSchema) })
  @ApiOkResponse({ schema: openApiResponseSchema(importProjectResponseSchema) })
  async importArchive(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
    @Body(zodPipe(importProjectRequestSchema)) body: ImportProjectRequest,
  ): Promise<ImportProjectResponse> {
    return this.archive.import({ projectId, userId: session.userId, request: body });
  }

  /**
   * Writes the project into a `.zip` and stores it as an attachment.
   *
   * `POST` rather than `GET` because it creates something, and an attachment
   * rather than a stream because that is the one answer all three clients can
   * use: the browser downloads it, an agent gets an id it can hand on, and the
   * file is deletable like every other (ADR-025, ADR-026).
   */
  @Post('export')
  @ApiCreatedResponse({ schema: openApiResponseSchema(exportProjectResponseSchema) })
  async exportArchive(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
  ): Promise<ExportProjectResponse> {
    return this.archive.export({ projectId, userId: session.userId });
  }

  @Post('builds')
  @ApiBody({ schema: openApiSchema(startProjectBuildRequestSchema) })
  @ApiCreatedResponse({ schema: openApiResponseSchema(startProjectBuildResponseSchema) })
  async startBuild(
    @CurrentSession() session: VerifiedSession,
    @Param('projectId') projectId: string,
    @Body(zodPipe(startProjectBuildRequestSchema)) body: StartProjectBuildRequest,
    @Headers() headers: ReaderLocaleHeaders,
  ): Promise<StartProjectBuildResponse> {
    return this.builds.start({ projectId, userId: session.userId, request: body, headers });
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
    @Headers() headers: ReaderLocaleHeaders,
  ): Promise<ProjectBuildResponse> {
    return { build: await this.builds.read(buildId, session.userId, headers) };
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

  /**
   * Reverse SyncTeX: which source line produced a place on a page.
   *
   * `x` and `y` are PDF points from the top left of the page, which is what
   * pdf.js hands out and what an agent reading the map means. A `GET` because
   * it is a question: nothing about the build changes by asking it.
   */
  @Get('source-map/source')
  @ApiOkResponse({ schema: openApiResponseSchema(projectSourceLookupResponseSchema) })
  async sourceAt(
    @CurrentSession() session: VerifiedSession,
    @Param('buildId') buildId: string,
    @Query('page') page: string,
    @Query('x') x: string,
    @Query('y') y: string,
  ): Promise<ProjectSourceLookupResponse> {
    return this.builds.lookupSource(buildId, session.userId, {
      page: readInteger(page, 'page'),
      x: readNumber(x, 'x'),
      y: readNumber(y, 'y'),
    });
  }

  /** Forward SyncTeX: where a source line ended up on the page. */
  @Get('source-map/position')
  @ApiOkResponse({ schema: openApiResponseSchema(projectPositionLookupResponseSchema) })
  async positionOf(
    @CurrentSession() session: VerifiedSession,
    @Param('buildId') buildId: string,
    @Query('file') file: string,
    @Query('line') line: string,
  ): Promise<ProjectPositionLookupResponse> {
    return this.builds.lookupPosition(buildId, session.userId, {
      file: file ?? '',
      line: readInteger(line, 'line'),
    });
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
    @Headers() headers: ReaderLocaleHeaders,
  ): Promise<ProjectBuildResponse> {
    return { build: await this.builds.cancel(buildId, session.userId, headers) };
  }
}

/**
 * A query parameter that has to be a number.
 *
 * Query strings arrive as text and a `NaN` that travels on becomes a lookup
 * that quietly answers about the top left corner, so the refusal happens here
 * rather than three calls down.
 */
function readNumber(value: string, name: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw AppError.validation(`The parameter ${name} must be a number`);
  }
  return parsed;
}

function readInteger(value: string, name: string): number {
  const parsed = readNumber(value, name);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw AppError.validation(`The parameter ${name} must be a positive integer`);
  }
  return parsed;
}
