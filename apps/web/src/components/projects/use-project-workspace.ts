'use client';

import * as React from 'react';

import { type Project, type ProjectBuild, type ProjectFile } from '@exocortex/contracts';

import {
  type CollaborationConnectionState,
  useCollaborationConnection,
} from '@/components/editor/collaboration-connection';
import {
  useCancelProjectBuild,
  useProject,
  useProjectBuild,
  useProjectFileMutation,
  useProjectFiles,
  useStartProjectBuild,
  useUpdateProject,
} from '@/lib/api/project-queries';
import { uploadAttachment, useSessionQuery } from '@/lib/api/queries';

/**
 * Everything one project screen needs, in one place (issue #43, ADR-027).
 *
 * Seven queries, one live connection and three pieces of local state, none of
 * which is about layout. Keeping them here leaves `ProjectView` a description
 * of three columns, which is what a component that draws three columns should
 * be -- and makes each derivation below testable as a plain function.
 */

/** Which file is open, without an effect writing the answer into state. */
export function resolveOpenPath(
  files: readonly ProjectFile[],
  rootFile: string,
  chosen: string | null,
): string | null {
  if (chosen !== null && files.some((file) => file.path === chosen)) return chosen;
  const root = files.find((file) => file.path === rootFile);
  if (root !== undefined) return root.path;
  return files.find((file) => file.kind === 'TEXT')?.path ?? null;
}

/** Whether the build is still going. */
export function isBuildRunning(build: ProjectBuild | null): boolean {
  return build !== null && (build.status === 'PENDING' || build.status === 'RUNNING');
}

export interface ProjectWorkspace {
  /** Null while the project is still loading, or if it does not exist. */
  project: Project | null;
  notFound: boolean;
  files: readonly ProjectFile[];
  connection: CollaborationConnectionState;
  selected: ProjectFile | null;
  focusLine: number | null;
  build: ProjectBuild | null;
  running: boolean;
  buildPending: boolean;
  writePending: boolean;
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  openFile: (path: string, line: number | null) => void;
  actions: {
    update: (request: Parameters<ReturnType<typeof useUpdateProject>['mutateAsync']>[0]) => void;
    createFile: (path: string) => void;
    deleteFile: (path: string) => void;
    upload: (file: File) => void;
    build: () => void;
    cancel: () => void;
  };
}

export function useProjectWorkspace(workspaceId: string, projectId: string): ProjectWorkspace {
  const session = useSessionQuery();
  const projectQuery = useProject(projectId);
  const filesQuery = useProjectFiles(projectId);
  const updateProject = useUpdateProject(projectId);
  const fileMutation = useProjectFileMutation(projectId);
  const startBuild = useStartProjectBuild(projectId);
  const cancelBuild = useCancelProjectBuild();

  const [chosenPath, setChosenPath] = React.useState<string | null>(null);
  const [focusLine, setFocusLine] = React.useState<number | null>(null);
  const [buildId, setBuildId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const buildQuery = useProjectBuild(buildId);
  const user = session.data?.user ?? null;
  const project = projectQuery.data?.project ?? null;
  const files = filesQuery.data?.files ?? [];
  const build = buildQuery.data?.build ?? null;

  const connection = useCollaborationConnection({
    documentId: projectId,
    documentTitle: project?.title ?? 'Projekt',
    currentUser: { id: user?.id ?? '', name: user?.name ?? '' },
  });

  const openPath = resolveOpenPath(files, project?.rootFile ?? '', chosenPath);
  const selected = files.find((file) => file.path === openPath) ?? null;

  const openFile = React.useCallback((path: string, line: number | null): void => {
    setChosenPath(path);
    setFocusLine(line);
  }, []);

  return {
    project: user === null ? null : project,
    notFound: projectQuery.isError,
    files,
    connection,
    selected,
    focusLine,
    build,
    running: isBuildRunning(build),
    buildPending: startBuild.isPending,
    writePending: fileMutation.write.isPending,
    createOpen,
    setCreateOpen,
    openFile,
    actions: {
      update: (request) => void updateProject.mutateAsync(request),
      createFile: (path) => {
        void fileMutation.write.mutateAsync({ path, content: '', createOnly: true }).then(() => {
          openFile(path, null);
          setCreateOpen(false);
        });
      },
      deleteFile: (path) => void fileMutation.remove.mutateAsync({ path, recursive: false }),
      upload: (file) => {
        // Two steps, because the bytes belong to the attachment module: it owns
        // the magic-byte check and the quota, and the project only binds the id
        // it gets back to a path.
        void uploadAttachment({ workspaceId, documentId: projectId, file }).then((uploaded) =>
          fileMutation.addAsset.mutateAsync({ path: file.name, attachmentId: uploaded.id }),
        );
      },
      build: () => {
        void startBuild.mutateAsync({ force: false }).then((result) => {
          setBuildId(result.build.id);
        });
      },
      cancel: () => {
        if (buildId !== null) void cancelBuild.mutateAsync(buildId);
      },
    },
  };
}
