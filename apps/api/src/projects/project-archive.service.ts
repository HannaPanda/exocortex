import { Inject, Injectable } from '@nestjs/common';

import {
  assertPolicy,
  canEditDocument,
  canReadDocument,
  WorkspaceAccessService,
} from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  checkProjectPath,
  detectProjectRootFile,
  type ExportProjectResponse,
  type ImportProjectRequest,
  type ImportProjectResponse,
  isProjectTextPath,
  PROJECT_MAX_ARCHIVE_BYTES,
  type ProjectImportSkip,
  type ProjectImportSkipReason,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

import { AttachmentsService } from '../attachments/attachments.service';
import { AppError } from '../common/app-error';
import { currentCorrelationId } from '../common/correlation';
import { API_ENV, LOGGER } from '../common/logger.provider';
import { PRISMA } from '../platform/platform-tokens';
import { SettingsService } from '../platform/settings.service';

import { ProjectBridgeService } from './project-bridge.service';
import { attachmentDownloadPath } from './project-mapper';
import { createZip, readZip, type ZipEntry, ZipError } from './zip';

/**
 * Getting a project in and out as a `.zip` (issue #54).
 *
 * Its own service because it is its own shape. Everything in `ProjectsService`
 * is one path and one operation; this is many of both, and the two questions it
 * has to answer -- what came in, and what did not -- have no counterpart there.
 *
 * Three rules hold here.
 *
 * **An archive is foreign input.** Every entry goes through `checkProjectPath`
 * before anything is written, which is what makes zip slip a non-event rather
 * than a patch: a path with `..` in it is refused by the same function that
 * refuses one a person typed. The uncompressed total is checked against the
 * central directory before a single byte is inflated, and again while
 * inflating, because a central directory is foreign input as well.
 *
 * **Nothing is swallowed in silence.** Every entry that did not become a file
 * is in the response with a reason. An import that quietly drops a third of a
 * thesis is worse than one that fails, because it fails later, at a build, in a
 * file nobody remembers packing.
 *
 * **Writes still go through the collaboration server.** An import is one bulk
 * operation rather than a write per file, so a thirty-file archive is one
 * transaction and one persist -- but it is the same bridge, and ADR-005 still
 * holds: the API never builds a project's Yjs state.
 */

/** Files the operating system puts in an archive and nobody wants in a project. */
const IGNORED_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const IGNORED_PREFIXES = ['__macosx/'];

/**
 * How much of one bulk operation's JSON goes to the collaboration server at a
 * time. Below its 8 MB body limit with room for the envelope and for JSON
 * escaping, which can double a byte.
 */
const IMPORT_BATCH_BYTES = 3 * 1024 * 1024;

interface PreparedImport {
  files: (
    | { kind: 'TEXT'; path: string; content: string }
    | {
        kind: 'ASSET';
        path: string;
        attachmentId: string;
        byteSize: number;
        mimeType: string | null;
      }
  )[];
  skipped: ProjectImportSkip[];
}

@Injectable()
export class ProjectArchiveService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly access: WorkspaceAccessService,
    private readonly settings: SettingsService,
    private readonly bridge: ProjectBridgeService,
    private readonly attachments: AttachmentsService,
  ) {}

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  async import(input: {
    projectId: string;
    userId: string;
    request: ImportProjectRequest;
  }): Promise<ImportProjectResponse> {
    const context = await this.access.requireDocumentContext(input.projectId, input.userId);
    assertPolicy(canEditDocument(context.role, context.document));
    if (context.document.type !== 'PROJECT') throw AppError.notFound('Project');
    const settings = await this.settings.getForWorkspace(context.workspaceId);

    const archive = await this.readArchive(
      input.request.attachmentId,
      input.userId,
      context.workspaceId,
    );
    let read;
    try {
      read = readZip(archive, { maxTotalBytes: PROJECT_MAX_ARCHIVE_BYTES });
    } catch (error) {
      if (error instanceof ZipError && error.code === 'archive_too_large') {
        throw new AppError(
          'project_archive_too_large',
          `Das Archiv enthält mehr als die erlaubten ${String(Math.round(PROJECT_MAX_ARCHIVE_BYTES / 1024 / 1024))} MB.`,
        );
      }
      throw new AppError('project_archive_unreadable', 'Diese Datei ist kein lesbares ZIP-Archiv.');
    }

    const strippedRoot = input.request.stripCommonRoot ? commonRoot(read.entries) : null;
    const taken = new Set(
      (
        await this.prisma.projectFile.findMany({
          where: { projectId: input.projectId },
          select: { path: true },
        })
      ).map((file) => file.path),
    );
    const budget = settings['projects.maxFiles'] - taken.size;

    const prepared = await this.prepare({
      entries: read.entries,
      skipped: read.skipped.map((entry) => ({ name: entry.name, reason: entry.reason })),
      strippedRoot,
      taken,
      overwrite: input.request.overwrite,
      budget,
      maxFileChars: settings['projects.maxFileChars'],
      workspaceId: context.workspaceId,
      projectId: input.projectId,
      userId: input.userId,
    });

    const imported = await this.applyBatches(input.projectId, input.userId, {
      files: prepared.files,
      overwrite: input.request.overwrite,
      maxFiles: settings['projects.maxFiles'],
    });

    const rootFile = await this.followRootFile(input.projectId, prepared.files);

    this.logger.info('Imported an archive into a project', {
      projectId: input.projectId,
      imported: imported.paths.length,
      skipped: prepared.skipped.length,
      correlationId: currentCorrelationId(),
    });

    return {
      projectId: input.projectId,
      imported: imported.paths,
      skipped: prepared.skipped,
      strippedRoot,
      rootFile: rootFile.path,
      rootFileChanged: rootFile.changed,
      appliedLive: imported.live,
    };
  }

  /**
   * Decides what each entry becomes, and uploads the assets.
   *
   * Everything that can refuse an entry happens here, before a single write
   * reaches the collaboration server: the path check, the two size limits, the
   * decode, the file budget. An import that got halfway and then hit a limit
   * would leave a project nobody can reason about.
   */
  private async prepare(input: {
    entries: readonly ZipEntry[];
    skipped: ProjectImportSkip[];
    strippedRoot: string | null;
    taken: ReadonlySet<string>;
    overwrite: boolean;
    budget: number;
    maxFileChars: number;
    workspaceId: string;
    projectId: string;
    userId: string;
  }): Promise<PreparedImport> {
    const skipped = [...input.skipped];
    const files: PreparedImport['files'] = [];
    const seen = new Set<string>();
    let budget = input.budget;

    const skip = (name: string, reason: ProjectImportSkipReason): void => {
      skipped.push({ name, reason });
    };

    for (const entry of input.entries) {
      const path = strip(entry.name, input.strippedRoot);
      if (isIgnored(path)) {
        skip(entry.name, 'ignored');
        continue;
      }
      if (checkProjectPath(path) !== null) {
        skip(entry.name, 'invalid_path');
        continue;
      }
      if (seen.has(path)) {
        skip(entry.name, 'exists');
        continue;
      }
      const occupied = input.taken.has(path);
      if (occupied && !input.overwrite) {
        skip(entry.name, 'exists');
        continue;
      }
      // Only a path that is not there yet costs one of the project's places.
      if (!occupied && budget <= 0) {
        skip(entry.name, 'too_many_files');
        continue;
      }

      if (isProjectTextPath(path)) {
        const content = decodeUtf8(entry.content);
        if (content === null) {
          skip(entry.name, 'not_utf8');
          continue;
        }
        if (content.length > input.maxFileChars) {
          skip(entry.name, 'too_large');
          continue;
        }
        files.push({ kind: 'TEXT', path, content });
      } else {
        if (entry.content.byteLength > this.env.MAX_UPLOAD_BYTES) {
          skip(entry.name, 'too_large');
          continue;
        }
        const asset = await this.storeAsset({
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          userId: input.userId,
          path,
          content: entry.content,
        });
        if (asset === null) {
          skip(entry.name, 'upload_failed');
          continue;
        }
        files.push({ kind: 'ASSET', path, ...asset });
      }

      seen.add(path);
      if (!occupied) budget -= 1;
    }

    return { files, skipped };
  }

  /**
   * Puts one entry's bytes into the attachment module.
   *
   * Best effort on purpose: a font the magic-byte sniff does not recognize is
   * one file of an archive, and refusing the whole import over it would make
   * the feature useless for exactly the archives it exists for. The entry is
   * reported as skipped instead.
   */
  private async storeAsset(input: {
    workspaceId: string;
    projectId: string;
    userId: string;
    path: string;
    content: Buffer;
  }): Promise<{ attachmentId: string; byteSize: number; mimeType: string | null } | null> {
    try {
      const uploaded = await this.attachments.upload({
        workspaceId: input.workspaceId,
        userId: input.userId,
        documentId: input.projectId,
        filename: input.path.slice(input.path.lastIndexOf('/') + 1),
        declaredMimeType: undefined,
        body: input.content,
        correlationId: currentCorrelationId(),
      });
      return {
        attachmentId: uploaded.attachment.id,
        byteSize: uploaded.attachment.byteSize,
        mimeType: uploaded.attachment.mimeType,
      };
    } catch (error) {
      this.logger.warn('An archive entry could not be stored as an attachment', {
        projectId: input.projectId,
        path: input.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Sends the prepared files to the collaboration server, in batches that fit.
   *
   * One apply would be one transaction and one persist, which is the whole
   * reason the bulk operation exists; the batching is only the body limit, and
   * a project that needs three batches still costs three persists rather than
   * three hundred.
   */
  private async applyBatches(
    projectId: string,
    userId: string,
    input: { files: PreparedImport['files']; overwrite: boolean; maxFiles: number },
  ): Promise<{ paths: string[]; live: boolean }> {
    const paths: string[] = [];
    let live = false;
    const correlationId = currentCorrelationId();

    let batch: PreparedImport['files'] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const applied = await this.bridge.apply({
        projectId,
        userId,
        operation: { op: 'import', files: batch, overwrite: input.overwrite },
        maxFiles: input.maxFiles,
        correlationId,
      });
      paths.push(...applied.paths);
      live = live || applied.live;
      batch = [];
      bytes = 0;
    };

    for (const file of input.files) {
      const size =
        file.kind === 'TEXT' ? Buffer.byteLength(file.content, 'utf8') + file.path.length : 200;
      if (bytes + size > IMPORT_BATCH_BYTES) await flush();
      batch.push(file);
      bytes += size;
    }
    await flush();

    return { paths: paths.sort(), live };
  }

  /**
   * Points the project at a main file the archive actually brought.
   *
   * Only when the current one is not among the imported files and is not
   * already in the project: an import that lands next to an existing thesis
   * must not silently move the build to the newcomer.
   */
  private async followRootFile(
    projectId: string,
    files: PreparedImport['files'],
  ): Promise<{ path: string; changed: boolean }> {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { documentId: projectId },
      select: { rootFile: true, type: true },
    });
    const present = await this.prisma.projectFile.findUnique({
      where: { projectId_path: { projectId, path: project.rootFile } },
      select: { kind: true },
    });
    const importedRoot = files.some((file) => file.path === project.rootFile);
    if (importedRoot || (present !== null && present.kind === 'TEXT')) {
      return { path: project.rootFile, changed: false };
    }

    const detected = detectProjectRootFile(
      project.type,
      files.filter((file) => file.kind === 'TEXT'),
    );
    if (detected === null) return { path: project.rootFile, changed: false };

    await this.prisma.project.update({
      where: { documentId: projectId },
      data: { rootFile: detected },
    });
    return { path: detected, changed: true };
  }

  /** The archive's bytes, checked to belong to this workspace. */
  private async readArchive(
    attachmentId: string,
    userId: string,
    workspaceId: string,
  ): Promise<Buffer> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { workspaceId: true, mimeType: true, deletedAt: true },
    });
    if (attachment === null || attachment.deletedAt !== null) throw AppError.notFound('Attachment');
    if (attachment.workspaceId !== workspaceId) {
      throw new AppError(
        'attachment_access_denied',
        'Die Datei gehört zu einem anderen Arbeitsbereich',
      );
    }
    if (attachment.mimeType !== 'application/zip') {
      throw AppError.validation('Diese Datei ist kein ZIP-Archiv');
    }

    // Through the attachment service, so the permission check on the file is
    // the one that module owns rather than a second copy of it here.
    const download = await this.attachments.download(attachmentId, userId);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks);
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  async export(input: { projectId: string; userId: string }): Promise<ExportProjectResponse> {
    const context = await this.access.requireDocumentContext(input.projectId, input.userId);
    assertPolicy(canReadDocument(context.role, context.document, context.workspaceId));
    if (context.document.type !== 'PROJECT') throw AppError.notFound('Project');

    const project = await this.prisma.project.findUniqueOrThrow({
      where: { documentId: input.projectId },
      select: {
        materializedAt: true,
        document: { select: { title: true, content: { select: { yjsUpdatedAt: true } } } },
      },
    });
    const rows = await this.prisma.projectFile.findMany({
      where: { projectId: input.projectId },
      select: {
        path: true,
        kind: true,
        content: true,
        attachmentId: true,
        attachment: { select: { deletedAt: true } },
      },
      orderBy: { path: 'asc' },
    });
    if (rows.length === 0) {
      throw new AppError('project_empty', 'Das Projekt enthält noch keine Dateien.');
    }

    const entries: ZipEntry[] = [];
    let total = 0;
    for (const row of rows) {
      let content: Buffer;
      if (row.kind === 'TEXT') {
        content = Buffer.from(row.content ?? '', 'utf8');
      } else if (row.attachmentId === null || row.attachment?.deletedAt != null) {
        // A path whose bytes are gone. Left out rather than written empty: an
        // empty file in the archive would look like a file, and the next build
        // from it would fail somewhere else entirely.
        continue;
      } else {
        content = await this.readAttachment(row.attachmentId, input.userId);
      }
      total += content.byteLength;
      if (total > PROJECT_MAX_ARCHIVE_BYTES) {
        throw new AppError(
          'project_archive_too_large',
          `Das Projekt ist größer als die erlaubten ${String(Math.round(PROJECT_MAX_ARCHIVE_BYTES / 1024 / 1024))} MB.`,
        );
      }
      entries.push({ name: row.path, content });
    }

    const archive = createZip(entries);
    const uploaded = await this.attachments.upload({
      workspaceId: context.workspaceId,
      userId: input.userId,
      documentId: input.projectId,
      filename: exportFilename(project.document.title),
      declaredMimeType: 'application/zip',
      body: archive,
      correlationId: currentCorrelationId(),
    });

    this.logger.info('Exported a project as an archive', {
      projectId: input.projectId,
      files: entries.length,
      byteSize: archive.byteLength,
      correlationId: currentCorrelationId(),
    });

    return {
      projectId: input.projectId,
      attachmentId: uploaded.attachment.id,
      filename: uploaded.attachment.filename,
      byteSize: uploaded.attachment.byteSize,
      fileCount: entries.length,
      downloadPath: attachmentDownloadPath(uploaded.attachment.id),
      stale:
        project.materializedAt === null ||
        project.document.content === null ||
        project.materializedAt < project.document.content.yjsUpdatedAt,
    };
  }

  private async readAttachment(attachmentId: string, userId: string): Promise<Buffer> {
    const download = await this.attachments.download(attachmentId, userId);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks);
  }
}

// ---------------------------------------------------------------------------
// Paths inside an archive
// ---------------------------------------------------------------------------

/**
 * The one folder every entry sits under, when there is one.
 *
 * Nearly every archive of a thesis carries one, and keeping it would leave
 * every path one level below where the `\input` lines inside the sources look.
 * Returns null the moment two entries disagree, so two trees can never be
 * silently merged into one.
 */
export function commonRoot(entries: readonly ZipEntry[]): string | null {
  let root: string | null = null;
  for (const entry of entries) {
    const slash = entry.name.indexOf('/');
    if (slash <= 0) return null;
    const head = entry.name.slice(0, slash);
    if (root === null) root = head;
    else if (root !== head) return null;
  }
  return root;
}

function strip(name: string, root: string | null): string {
  const withoutDot = name.startsWith('./') ? name.slice(2) : name;
  if (root === null) return withoutDot;
  return withoutDot.startsWith(`${root}/`) ? withoutDot.slice(root.length + 1) : withoutDot;
}

function isIgnored(path: string): boolean {
  const lower = path.toLowerCase();
  if (IGNORED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  return IGNORED_NAMES.has(lower.slice(lower.lastIndexOf('/') + 1));
}

/**
 * Text, or null when the bytes are not UTF-8.
 *
 * A lossy decode would put replacement characters into a `.tex` file and hand
 * the person a build that fails on a character they cannot see. Refusing names
 * the file instead.
 */
function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A filename a download dialog can show, derived from the project's title. */
function exportFilename(title: string): string {
  const stem = title
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return `${stem.length === 0 ? 'projekt' : stem}.zip`;
}
