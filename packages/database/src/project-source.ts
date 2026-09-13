import { createHash } from 'node:crypto';

import { type ProjectBibliography, type ProjectEngine } from '@exocortex/contracts';

import { type PrismaClient } from './client';

/**
 * What goes into a project build, and the fingerprint two builds are compared
 * by (issue #43, ADR-027).
 *
 * Both halves live here rather than in the API for the same reason
 * `render-source.ts` does: the API computes the hash when it accepts a request
 * and the worker assembles the archive when it runs the build, and a second
 * implementation of either would drift silently -- a hash that disagrees turns
 * the cache into a machine that rebuilds an unchanged project for ever, and an
 * archive that disagrees compiles something nobody asked for.
 */

/** One text file, as it goes into the archive. */
export interface ProjectBuildTextFile {
  path: string;
  content: string;
}

/** One binary file, as it goes into the archive. */
export interface ProjectBuildAsset {
  path: string;
  attachmentId: string;
  storageKey: string;
  byteSize: number;
  /** Content hash when the upload recorded one; the size stands in when not. */
  checksum: string | null;
}

export interface ProjectBuildInput {
  projectId: string;
  workspaceId: string;
  title: string;
  rootFile: string;
  engine: ProjectEngine;
  bibliography: ProjectBibliography;
  texts: ProjectBuildTextFile[];
  assets: ProjectBuildAsset[];
  /** False when the projection has never been built from the Yjs state. */
  materialized: boolean;
}

/**
 * Everything a build needs, read from the derived `ProjectFile` rows.
 *
 * The rows rather than the Yjs state, deliberately: the worker would otherwise
 * decode a CRDT to get at text a materialization pass has already written down,
 * and the two could then disagree about what "the project" is at the moment the
 * build started. Reading the projection means a build compiles exactly what the
 * file list, the editor and the agent last agreed on -- and a project whose
 * projection is not built yet is a refusal, not a half-empty archive.
 */
export async function loadProjectBuildInput(
  prisma: PrismaClient,
  projectId: string,
): Promise<ProjectBuildInput | null> {
  const project = await prisma.project.findUnique({
    where: { documentId: projectId },
    select: {
      documentId: true,
      rootFile: true,
      engine: true,
      bibliography: true,
      materializedAt: true,
      document: { select: { workspaceId: true, title: true } },
      files: {
        select: {
          path: true,
          kind: true,
          content: true,
          byteSize: true,
          attachmentId: true,
          attachment: { select: { id: true, storageKey: true, byteSize: true, checksum: true } },
        },
        orderBy: { path: 'asc' },
      },
    },
  });
  if (project === null) return null;

  const texts: ProjectBuildTextFile[] = [];
  const assets: ProjectBuildAsset[] = [];
  for (const file of project.files) {
    if (file.kind === 'TEXT') {
      texts.push({ path: file.path, content: file.content ?? '' });
      continue;
    }
    // An asset whose attachment was deleted is left out rather than faked: the
    // build then fails on a missing image, which is what actually happened,
    // instead of on a zero-byte file that looks like a corrupt one.
    if (file.attachment === null) continue;
    assets.push({
      path: file.path,
      attachmentId: file.attachment.id,
      storageKey: file.attachment.storageKey,
      byteSize: file.attachment.byteSize,
      checksum: file.attachment.checksum,
    });
  }

  return {
    projectId: project.documentId,
    workspaceId: project.document.workspaceId,
    title: project.document.title,
    rootFile: project.rootFile,
    engine: project.engine,
    bibliography: project.bibliography,
    texts,
    assets,
    materialized: project.materializedAt !== null,
  };
}

/**
 * The fingerprint two builds are compared by.
 *
 * Everything that changes the bytes of the PDF, and nothing else. An asset
 * contributes its checksum rather than its content: hashing a hundred megabytes
 * of images on every request would make the cache more expensive than the
 * build it saves, and an attachment's bytes are immutable once uploaded, so its
 * id and checksum say the same thing about it that reading it would.
 *
 * The container image is deliberately absent, for the reason it is absent from
 * `renderInputHash`: it is not read at request time, and a hash that changed
 * under every deployment would make the cache useless. `force` is what covers
 * a changed image.
 */
export function projectInputHash(input: {
  engine: string;
  bibliography: string;
  rootFile: string;
  texts: readonly ProjectBuildTextFile[];
  assets: readonly {
    path: string;
    attachmentId: string;
    checksum: string | null;
    byteSize: number;
  }[];
}): string {
  const hash = createHash('sha256');
  hash.update(`${input.engine}\u0000${input.bibliography}\u0000${input.rootFile}\u0000`);
  for (const text of [...input.texts].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(
      `T\u0000${text.path}\u0000${String(text.content.length)}\u0000${text.content}\u0000`,
    );
  }
  for (const asset of [...input.assets].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    hash.update(
      `A\u0000${asset.path}\u0000${asset.attachmentId}\u0000${asset.checksum ?? String(asset.byteSize)}\u0000`,
    );
  }
  return hash.digest('hex');
}
