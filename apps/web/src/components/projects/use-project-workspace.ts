'use client';

import { useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import {
  type ImportProjectResponse,
  type Project,
  type ProjectBuild,
  type ProjectFile,
} from '@exocortex/contracts';

import {
  type CollaborationConnectionState,
  useCollaborationConnection,
} from '@/components/editor/collaboration-connection';
import {
  projectKeys,
  useCancelProjectBuild,
  useDeleteProjectBuild,
  useExportProject,
  useImportProject,
  useProject,
  useProjectBuild,
  useProjectBuilds,
  useProjectFileMutation,
  useProjectFiles,
  useStartProjectBuild,
  useUpdateProject,
} from '@/lib/api/project-queries';
import { uploadAttachment, useSessionQuery } from '@/lib/api/queries';

import { type ProjectSourceSync, useProjectSourceSync } from './use-project-source-sync';

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

/** The file forward sync asks about: the open text file, or nothing. */
export function syncPath(selected: ProjectFile | null): string | null {
  return selected !== null && selected.kind === 'TEXT' ? selected.path : null;
}

/** Whether the build is still going. */
export function isBuildRunning(build: ProjectBuild | null): boolean {
  return build !== null && (build.status === 'PENDING' || build.status === 'RUNNING');
}

/**
 * Which build the screen shows: the one just started, else the newest there is.
 *
 * The fallback is the whole point. Before it, the id lived only in React state,
 * so a reload emptied the right-hand column and the PDF that had just been
 * built had no route back to it in the browser at all -- while
 * `exo_project_builds` handed an agent the same list (ADR-025).
 */
export function resolveShownBuild(
  builds: readonly ProjectBuild[],
  chosen: string | null,
): string | null {
  // A chosen id wins even when the list does not have it yet: a build that was
  // started a second ago is not in a list that is refetched when one finishes.
  if (chosen !== null) return chosen;
  return builds[0]?.id ?? null;
}

export interface ProjectWorkspace {
  /** Null while the project is still loading, or if it does not exist. */
  project: Project | null;
  notFound: boolean;
  files: readonly ProjectFile[];
  connection: CollaborationConnectionState;
  selected: ProjectFile | null;
  focusLine: number | null;
  /** Rises with every jump, so asking for the same line twice moves twice. */
  focusNonce: number;
  build: ProjectBuild | null;
  /** Every build this project has had, newest first. */
  builds: readonly ProjectBuild[];
  running: boolean;
  buildPending: boolean;
  writePending: boolean;
  /** What the last archive import did, until it is dismissed. */
  importResult: ImportProjectResponse | null;
  archivePending: boolean;
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  /** Both directions of SyncTeX, between the source pane and the PDF (issue #53). */
  sourceSync: ProjectSourceSync;
  openFile: (path: string, line: number | null) => void;
  selectBuild: (buildId: string) => void;
  actions: {
    update: (request: Parameters<ReturnType<typeof useUpdateProject>['mutateAsync']>[0]) => void;
    createFile: (path: string) => void;
    deleteFile: (path: string) => void;
    upload: (file: File) => void;
    importArchive: (file: File) => void;
    /** Repeats the last import, this time replacing files that were in the way. */
    importOverwrite: () => void;
    dismissImport: () => void;
    exportArchive: () => void;
    build: () => void;
    cancel: () => void;
    deleteBuild: (buildId: string) => void;
  };
}

export function useProjectWorkspace(workspaceId: string, projectId: string): ProjectWorkspace {
  const session = useSessionQuery();
  const projectQuery = useProject(projectId);
  const filesQuery = useProjectFiles(projectId);
  const updateProject = useUpdateProject(projectId);
  const fileMutation = useProjectFileMutation(projectId);
  const builds = useBuildSelection(workspaceId, projectId);
  const archive = useArchive(workspaceId, projectId);

  const [chosenPath, setChosenPath] = React.useState<string | null>(null);
  const [focusLine, setFocusLine] = React.useState<number | null>(null);
  const [focusNonce, setFocusNonce] = React.useState(0);
  const [createOpen, setCreateOpen] = React.useState(false);

  const user = session.data?.user ?? null;
  const project = projectQuery.data?.project ?? null;
  const files = filesQuery.data?.files ?? [];

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
    // Counted rather than compared: clicking the same place in the PDF twice
    // asks for the same line twice, and the second ask has to move the caret
    // back to it just as the first one did.
    setFocusNonce((nonce) => nonce + 1);
  }, []);

  const sourceSync = useProjectSourceSync({
    buildId: builds.build?.id ?? null,
    file: syncPath(selected),
    openFile,
  });

  return {
    project: user === null ? null : project,
    notFound: projectQuery.isError,
    files,
    connection,
    selected,
    focusLine,
    focusNonce,
    build: builds.build,
    builds: builds.builds,
    running: builds.running,
    buildPending: builds.pending,
    writePending: fileMutation.write.isPending,
    importResult: archive.result,
    archivePending: archive.pending,
    createOpen,
    setCreateOpen,
    sourceSync,
    openFile,
    selectBuild: builds.select,
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
      importArchive: archive.importFile,
      importOverwrite: archive.importOverwrite,
      dismissImport: archive.dismiss,
      exportArchive: archive.exportArchive,
      build: builds.start,
      cancel: builds.cancel,
      deleteBuild: builds.remove,
    },
  };
}

interface ArchiveActions {
  result: ImportProjectResponse | null;
  pending: boolean;
  importFile: (file: File) => void;
  importOverwrite: () => void;
  dismiss: () => void;
  exportArchive: () => void;
}

/**
 * The two archive buttons (issue #54).
 *
 * Its own hook because both halves carry a piece of state the rest of the
 * screen has no use for: the attachment id of the archive that was just
 * imported, so asking again with `overwrite` costs no second upload, and the
 * result until somebody has read it.
 */
function useArchive(workspaceId: string, projectId: string): ArchiveActions {
  const importProject = useImportProject(projectId);
  const exportProject = useExportProject(projectId);
  const [result, setResult] = React.useState<ImportProjectResponse | null>(null);
  const [lastArchiveId, setLastArchiveId] = React.useState<string | null>(null);

  const run = (attachmentId: string, overwrite: boolean): void => {
    void importProject.mutateAsync({ attachmentId, overwrite }).then((imported) => {
      setLastArchiveId(attachmentId);
      setResult(imported);
    });
  };

  return {
    result,
    pending: importProject.isPending || exportProject.isPending,
    importFile: (file) => {
      // The same two steps an agent takes: the bytes become an ordinary
      // attachment, and the import names its id.
      void uploadAttachment({ workspaceId, documentId: projectId, file }).then((uploaded) => {
        run(uploaded.id, false);
      });
    },
    importOverwrite: () => {
      if (lastArchiveId !== null) run(lastArchiveId, true);
    },
    dismiss: () => setResult(null),
    exportArchive: () => {
      void exportProject.mutateAsync().then((archive) => {
        // The archive is an ordinary attachment, so the download route serves
        // it with the filename already set.
        window.location.assign(archive.downloadPath);
      });
    },
  };
}

interface BuildSelection {
  build: ProjectBuild | null;
  builds: readonly ProjectBuild[];
  running: boolean;
  pending: boolean;
  select: (buildId: string) => void;
  start: () => void;
  cancel: () => void;
  remove: (buildId: string) => void;
}

/**
 * Which build the right-hand column shows, and the four things one can do to it.
 *
 * Its own hook because it is its own question: the list, the chosen id, the
 * poll of that one build and the invalidation when it settles all belong
 * together, and the screen around them only needs the answer.
 */
function useBuildSelection(workspaceId: string, projectId: string): BuildSelection {
  const startBuild = useStartProjectBuild(projectId);
  const cancelBuild = useCancelProjectBuild();
  const deleteBuild = useDeleteProjectBuild(workspaceId, projectId);
  const buildsQuery = useProjectBuilds(workspaceId, projectId);
  const queryClient = useQueryClient();

  const [chosenId, setChosenId] = React.useState<string | null>(null);
  const builds = buildsQuery.data?.builds ?? [];
  const shownId = resolveShownBuild(builds, chosenId);
  const build = useProjectBuild(shownId).data?.build ?? null;

  // A build that has just settled changes the list: its status and its file
  // size, and the row has to appear at all. The list is not polled.
  const settled = build !== null && !isBuildRunning(build) ? build.status : null;
  React.useEffect(() => {
    if (settled === null) return;
    void queryClient.invalidateQueries({ queryKey: projectKeys.builds(workspaceId, projectId) });
  }, [projectId, queryClient, settled, workspaceId]);

  return {
    build,
    builds,
    running: isBuildRunning(build),
    pending: startBuild.isPending,
    select: setChosenId,
    start: () => {
      void startBuild.mutateAsync({ force: false }).then((result) => {
        setChosenId(result.build.id);
      });
    },
    cancel: () => {
      if (shownId !== null) void cancelBuild.mutateAsync(shownId);
    },
    remove: (buildId) => {
      // Let go of it first when it is the one on screen, or the panel keeps
      // polling a build that no longer exists.
      if (buildId === shownId) setChosenId(null);
      void deleteBuild.mutateAsync(buildId);
    },
  };
}
