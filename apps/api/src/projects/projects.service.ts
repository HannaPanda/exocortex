import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canCreateDocument,
  canEditDocument,
  canReadDocument,
  canReadWorkspace,
  WorkspaceAccessService,
} from '@exocortex/auth';
import {
  type AddProjectAssetRequest,
  checkProjectPath,
  type CreateProjectRequest,
  type DeleteProjectFileRequest,
  isProjectTextPath,
  latexScaffold,
  type MoveProjectFileRequest,
  type PatchProjectFileRequest,
  type Project,
  type ProjectFileContentResponse,
  type ProjectFileListResponse,
  type ProjectListResponse,
  type ProjectMutationResponse,
  projectPathProblemMessage,
  type UpdateProjectRequest,
  type WriteProjectFileRequest,
} from '@exocortex/contracts';
import { type Prisma, type PrismaClient } from '@exocortex/database';
import { projectFilesToYjsState } from '@exocortex/editor';
import { type Logger } from '@exocortex/logger';

import { AppError } from '../common/app-error';
import { currentCorrelationId } from '../common/correlation';
import { LOGGER } from '../common/logger.provider';
import { OutboxService } from '../common/outbox.service';
import { resolveOrderKey } from '../documents/document-order';
import { PRISMA } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';

import { ProjectBridgeService } from './project-bridge.service';
import { mapProject, PROJECT_SELECT, projectFileDownloadPath } from './project-mapper';

/**
 * The project domain (issue #43, ADR-027).
 *
 * Three rules hold everywhere in this file.
 *
 * **A project is a document.** Its tree position, title, permissions, trash and
 * snapshots are a document's, so none of that is implemented here and deleting
 * a project is deleting its document. What is here is the sidecar and the file
 * tree.
 *
 * **Writes go through the collaboration server, reads come from the rows.** The
 * canonical file tree is a CRDT; the API never builds Yjs state from the
 * `ProjectFile` rows it derived from that same state (ADR-005). The one
 * exception is creation, where there is no state yet to apply an operation to.
 *
 * **Nothing here knows what LaTeX is.** `ProjectType` decides the scaffold and
 * the runner; every route below works the same for the next project type.
 */
@Injectable()
export class ProjectsService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly access: WorkspaceAccessService,
    private readonly settings: SettingsService,
    private readonly outbox: OutboxService,
    private readonly bridge: ProjectBridgeService,
  ) {}

  // -------------------------------------------------------------------------
  // The project itself
  // -------------------------------------------------------------------------

  async create(input: {
    workspaceId: string;
    userId: string;
    request: CreateProjectRequest;
  }): Promise<Project> {
    const role = await this.access.findRole(input.workspaceId, input.userId);
    assertPolicy(canCreateDocument(role));

    const parentId = input.request.parentId;
    if (parentId !== null) {
      const parent = await this.prisma.document.findUnique({
        where: { id: parentId },
        select: { workspaceId: true, archivedAt: true },
      });
      if (parent === null) throw AppError.notFound('Parent document');
      if (parent.workspaceId !== input.workspaceId) {
        throw new AppError(
          'document_cross_workspace',
          'The parent document belongs to a different workspace',
        );
      }
      if (parent.archivedAt !== null) {
        throw new AppError('document_archived', 'Cannot create a project under an archived parent');
      }
    }

    const orderKey = await resolveOrderKey(this.prisma, {
      workspaceId: input.workspaceId,
      parentId,
      afterSiblingId: null,
      beforeSiblingId: null,
    });

    // The only place a project's Yjs state is built rather than edited: there
    // is no document to apply an operation to until this row exists.
    const files = input.request.scaffold
      ? [{ path: input.request.rootFile, content: latexScaffold(input.request.title) }]
      : [];
    const yjsState = Buffer.from(projectFilesToYjsState(files));
    const correlationId = currentCorrelationId();
    const materializedAt = new Date();

    const created = await this.prisma.$transaction(async (tx) => {
      const document = await tx.document.create({
        data: {
          workspaceId: input.workspaceId,
          parentId,
          type: 'PROJECT',
          title: input.request.title,
          // A file tree wants the width a page does not.
          layout: 'FULL',
          orderKey,
          createdById: input.userId,
          updatedById: input.userId,
        },
        select: { id: true },
      });

      await tx.documentContent.create({
        data: {
          documentId: document.id,
          yjsState,
          // The project shape, not the editor's: a project's state is versioned
          // by this module and never migrated by the ProseMirror migrations.
          schemaVersion: 1,
          // Both stamps, and deliberately the same value. `yjsUpdatedAt`
          // defaults to the database's `now()`, which is a few milliseconds
          // later than this one -- enough for `materializedAt < yjsUpdatedAt`
          // to be true the moment the row is written, so a brand-new project
          // reported its file tree out of date for ever and the browser polled
          // it every one and a half seconds waiting for a job that had nothing
          // to do.
          yjsUpdatedAt: materializedAt,
          materializedAt,
        },
      });

      await tx.project.create({
        data: {
          documentId: document.id,
          type: input.request.type,
          rootFile: input.request.rootFile,
          engine: input.request.engine,
          bibliography: input.request.bibliography,
          // Materialized here rather than left to the job: the rows are written
          // in this same transaction, so claiming otherwise would make a freshly
          // created project report itself unready for a second or two.
          materializedAt,
        },
      });

      for (const file of files) {
        await tx.projectFile.create({
          data: {
            projectId: document.id,
            path: file.path,
            kind: 'TEXT',
            content: file.content,
            byteSize: Buffer.byteLength(file.content, 'utf8'),
          },
        });
      }

      await this.outbox.writeEvent(tx, {
        workspaceId: input.workspaceId,
        type: 'document.created',
        payload: { documentId: document.id },
        correlationId,
      });

      return tx.project.findUniqueOrThrow({
        where: { documentId: document.id },
        select: PROJECT_SELECT,
      });
    });

    this.logger.info('Project created', {
      projectId: created.documentId,
      workspaceId: input.workspaceId,
      type: input.request.type,
      correlationId,
    });
    return mapProject(created);
  }

  async read(projectId: string, userId: string): Promise<Project> {
    const row = await this.requireProject(projectId, userId);
    return mapProject(row);
  }

  async list(workspaceId: string, userId: string): Promise<ProjectListResponse> {
    const role = await this.access.findRole(workspaceId, userId);
    assertPolicy(canReadWorkspace(role));

    const rows = await this.prisma.project.findMany({
      where: { document: { workspaceId, archivedAt: null } },
      select: PROJECT_SELECT,
      orderBy: { document: { title: 'asc' } },
    });
    const settings = await this.settings.getForWorkspace(workspaceId);
    return {
      projects: rows.map((row) => mapProject(row)),
      buildEnabled: settings['projects.enabled'],
    };
  }

  async update(input: {
    projectId: string;
    userId: string;
    request: UpdateProjectRequest;
  }): Promise<Project> {
    const context = await this.access.requireDocumentContext(input.projectId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));
    if (context.document.type !== 'PROJECT') throw AppError.notFound('Project');

    // A root file that is not in the tree produces a build failure whose cause
    // nobody can read from the log. Refusing here says it plainly instead.
    if (input.request.rootFile !== undefined) {
      const exists = await this.prisma.projectFile.findUnique({
        where: { projectId_path: { projectId: input.projectId, path: input.request.rootFile } },
        select: { kind: true },
      });
      if (exists === null || exists.kind !== 'TEXT') {
        throw AppError.validation(
          `The root file "${input.request.rootFile}" does not exist in the project`,
        );
      }
    }

    const data: Prisma.ProjectUpdateInput = {};
    if (input.request.rootFile !== undefined) data.rootFile = input.request.rootFile;
    if (input.request.engine !== undefined) data.engine = input.request.engine;
    if (input.request.bibliography !== undefined) data.bibliography = input.request.bibliography;

    const row = await this.prisma.$transaction(async (tx) => {
      if (input.request.title !== undefined) {
        await tx.document.update({
          where: { id: input.projectId },
          data: { title: input.request.title, updatedById: input.userId },
        });
      }
      if (Object.keys(data).length > 0) {
        await tx.project.update({ where: { documentId: input.projectId }, data });
      }
      return tx.project.findUniqueOrThrow({
        where: { documentId: input.projectId },
        select: PROJECT_SELECT,
      });
    });
    return mapProject(row);
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  async listFiles(projectId: string, userId: string): Promise<ProjectFileListResponse> {
    const row = await this.requireProject(projectId, userId);
    const files = await this.prisma.projectFile.findMany({
      where: { projectId },
      select: {
        path: true,
        kind: true,
        byteSize: true,
        attachmentId: true,
        updatedAt: true,
        attachment: { select: { mimeType: true, deletedAt: true } },
      },
      orderBy: { path: 'asc' },
    });

    return {
      projectId,
      files: files.map((file) => ({
        path: file.path,
        kind: file.kind,
        byteSize: file.byteSize,
        attachmentId: file.attachmentId,
        downloadPath: projectFileDownloadPath(
          file.attachmentId,
          file.attachment?.deletedAt ?? null,
        ),
        mimeType: file.attachment?.mimeType ?? null,
        updatedAt: file.updatedAt.toISOString(),
      })),
      // No content row cannot happen for a project the API created; treating
      // it as stale rather than fresh is the safe direction if it ever does.
      stale:
        row.materializedAt === null ||
        row.document.content === null ||
        row.materializedAt < row.document.content.yjsUpdatedAt,
    };
  }

  async readFile(
    projectId: string,
    userId: string,
    path: string,
  ): Promise<ProjectFileContentResponse> {
    await this.requireProject(projectId, userId);
    const file = await this.prisma.projectFile.findUnique({
      where: { projectId_path: { projectId, path } },
      select: {
        path: true,
        kind: true,
        content: true,
        byteSize: true,
        attachmentId: true,
        updatedAt: true,
        attachment: { select: { deletedAt: true } },
      },
    });
    if (file === null) {
      throw new AppError('project_file_not_found', 'This file does not exist in the project');
    }

    return {
      projectId,
      path: file.path,
      kind: file.kind,
      content: file.kind === 'TEXT' ? (file.content ?? '') : null,
      byteSize: file.byteSize,
      truncated: false,
      downloadPath: projectFileDownloadPath(file.attachmentId, file.attachment?.deletedAt ?? null),
      updatedAt: file.updatedAt.toISOString(),
    };
  }

  async writeFile(input: {
    projectId: string;
    userId: string;
    request: WriteProjectFileRequest;
  }): Promise<ProjectMutationResponse> {
    const settings = await this.requireWritableProject(input.projectId, input.userId);
    this.assertPath(input.request.path);

    const limit = settings['projects.maxFileChars'];
    if (input.request.content.length > limit) {
      throw AppError.validation(`This file is longer than the allowed ${String(limit)} characters`);
    }
    // A binary path with text content would produce a file the build treats as
    // an image and the editor as source. Refusing is kinder than either.
    if (!isProjectTextPath(input.request.path)) {
      throw new AppError(
        'project_not_a_text_file',
        `"${input.request.path}" is not a text file; binary files are uploaded as attachments`,
      );
    }

    return this.applyOperation(input.projectId, input.userId, settings['projects.maxFiles'], {
      op: 'write',
      path: input.request.path,
      content: input.request.content,
      createOnly: input.request.createOnly,
    });
  }

  async patchFile(input: {
    projectId: string;
    userId: string;
    request: PatchProjectFileRequest;
  }): Promise<ProjectMutationResponse> {
    const settings = await this.requireWritableProject(input.projectId, input.userId);
    this.assertPath(input.request.path);

    return this.applyOperation(input.projectId, input.userId, settings['projects.maxFiles'], {
      op: 'patch',
      path: input.request.path,
      oldText: input.request.oldText,
      newText: input.request.newText,
      replaceAll: input.request.replaceAll,
    });
  }

  async moveFile(input: {
    projectId: string;
    userId: string;
    request: MoveProjectFileRequest;
  }): Promise<ProjectMutationResponse> {
    const settings = await this.requireWritableProject(input.projectId, input.userId);
    this.assertPath(input.request.from);
    this.assertPath(input.request.to);
    // Moving a directory into itself would rewrite every path into an ever
    // deeper copy of the same name, one materialization at a time.
    if (input.request.to.startsWith(`${input.request.from}/`)) {
      throw AppError.validation('A folder cannot be moved into itself');
    }

    const result = await this.applyOperation(
      input.projectId,
      input.userId,
      settings['projects.maxFiles'],
      {
        op: 'move',
        from: input.request.from,
        to: input.request.to,
        recursive: input.request.recursive,
      },
    );
    await this.followRootFile(input.projectId, input.request.from, input.request.to);
    return result;
  }

  async deleteFile(input: {
    projectId: string;
    userId: string;
    request: DeleteProjectFileRequest;
  }): Promise<ProjectMutationResponse> {
    const settings = await this.requireWritableProject(input.projectId, input.userId);
    this.assertPath(input.request.path);

    return this.applyOperation(input.projectId, input.userId, settings['projects.maxFiles'], {
      op: 'delete',
      path: input.request.path,
      recursive: input.request.recursive,
    });
  }

  /**
   * Binds an already uploaded attachment to a path in the tree.
   *
   * Two steps rather than one multipart route, and deliberately so: the upload
   * is the attachment module's, which owns the magic-byte sniff, the quota and
   * the permission check, and a second upload path here would be a second place
   * all three could be got wrong.
   */
  async addAsset(input: {
    projectId: string;
    userId: string;
    request: AddProjectAssetRequest;
  }): Promise<ProjectMutationResponse> {
    const settings = await this.requireWritableProject(input.projectId, input.userId);
    this.assertPath(input.request.path);

    const context = await this.access.requireDocumentContext(input.projectId, input.userId);
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: input.request.attachmentId },
      select: { id: true, workspaceId: true, byteSize: true, mimeType: true, deletedAt: true },
    });
    if (attachment === null || attachment.deletedAt !== null) {
      throw AppError.notFound('Attachment');
    }
    if (attachment.workspaceId !== context.workspaceId) {
      throw new AppError('attachment_access_denied', 'The file belongs to another workspace');
    }

    return this.applyOperation(input.projectId, input.userId, settings['projects.maxFiles'], {
      op: 'asset',
      path: input.request.path,
      attachmentId: attachment.id,
      byteSize: attachment.byteSize,
      mimeType: attachment.mimeType,
    });
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  private assertPath(path: string): void {
    const problem = checkProjectPath(path);
    if (problem !== null) throw AppError.validation(projectPathProblemMessage(problem));
  }

  private async applyOperation(
    projectId: string,
    userId: string,
    maxFiles: number,
    operation: Parameters<ProjectBridgeService['apply']>[0]['operation'],
  ): Promise<ProjectMutationResponse> {
    const applied = await this.bridge.apply({
      projectId,
      userId,
      operation,
      maxFiles,
      correlationId: currentCorrelationId(),
    });
    return { projectId, paths: applied.paths, appliedLive: applied.live };
  }

  /**
   * Keeps the root file pointing at the file it named after a move.
   *
   * Without this, renaming `main.tex` leaves a project whose next build fails
   * on a file the person renaming it can see is gone -- and the fix would be a
   * second, unrelated-looking settings change.
   */
  private async followRootFile(projectId: string, from: string, to: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { documentId: projectId },
      select: { rootFile: true },
    });
    if (project === null) return;
    const rewritten =
      project.rootFile === from
        ? to
        : project.rootFile.startsWith(`${from}/`)
          ? `${to}${project.rootFile.slice(from.length)}`
          : null;
    if (rewritten === null) return;
    await this.prisma.project.update({
      where: { documentId: projectId },
      data: { rootFile: rewritten },
    });
  }

  private async requireProject(
    projectId: string,
    userId: string,
  ): Promise<Prisma.ProjectGetPayload<{ select: typeof PROJECT_SELECT }>> {
    const context = await this.access.requireDocumentContext(projectId, userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));
    if (context.document.type !== 'PROJECT') throw AppError.notFound('Project');

    const row = await this.prisma.project.findUnique({
      where: { documentId: projectId },
      select: PROJECT_SELECT,
    });
    if (row === null) throw AppError.notFound('Project');
    return row;
  }

  /** Read access plus write access plus the workspace's resolved settings. */
  private async requireWritableProject(projectId: string, userId: string) {
    const context = await this.access.requireDocumentContext(projectId, userId);
    assertPolicy(canEditDocument(context.role, context.document));
    if (context.document.type !== 'PROJECT') throw AppError.notFound('Project');
    return this.settings.getForWorkspace(context.workspaceId);
  }
}
