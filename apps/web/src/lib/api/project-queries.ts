'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type AddProjectAssetRequest,
  type CreateProjectInput,
  type DeleteProjectBuildResponse,
  type DeleteProjectFileRequest,
  type MoveProjectFileRequest,
  type PatchProjectFileRequest,
  type ProjectBuildArtifactsResponse,
  type ProjectBuildDiagnosticsResponse,
  type ProjectBuildListResponse,
  type ProjectBuildLogResponse,
  type ProjectBuildResponse,
  type ProjectFileListResponse,
  type ProjectMutationResponse,
  type ProjectResponse,
  type StartProjectBuildRequest,
  type StartProjectBuildResponse,
  type UpdateProjectRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * Projects and their builds (issue #43, ADR-027).
 *
 * A running build is polled rather than pushed at, for the same reason a render
 * is: `project.build.updated` exists and the page listens for it, but a build
 * that takes two minutes must also finish for somebody whose socket dropped in
 * the meantime. Polling stops the moment the build reaches a terminal status.
 *
 * The file *contents* are not fetched through here at all. They come over the
 * collaboration socket, because the project's Yjs state is where they live; the
 * queries below are the tree, the settings and the builds.
 */

export const projectKeys = {
  list: (workspaceId: string) => ['workspace', workspaceId, 'projects'] as const,
  project: (projectId: string) => ['project', projectId] as const,
  files: (projectId: string) => ['project', projectId, 'files'] as const,
  builds: (workspaceId: string, projectId?: string) =>
    ['workspace', workspaceId, 'project-builds', projectId ?? 'all'] as const,
  build: (buildId: string) => ['project-build', buildId] as const,
  diagnostics: (buildId: string) => ['project-build', buildId, 'diagnostics'] as const,
  log: (buildId: string) => ['project-build', buildId, 'log'] as const,
  artifacts: (buildId: string) => ['project-build', buildId, 'artifacts'] as const,
};

export function useProject(projectId: string | undefined): UseQueryResult<ProjectResponse> {
  return useQuery({
    queryKey: projectKeys.project(projectId ?? 'none'),
    queryFn: () => apiRequest<ProjectResponse>(`/api/projects/${projectId ?? ''}`),
    enabled: projectId !== undefined,
  });
}

/**
 * The file tree.
 *
 * Refetched while the projection is behind the Yjs state: the rows are rebuilt
 * by a debounced job, so a file somebody just created appears a second or two
 * later, and a tree that needs a manual reload to show it would look broken.
 */
export function useProjectFiles(
  projectId: string | undefined,
): UseQueryResult<ProjectFileListResponse> {
  return useQuery({
    queryKey: projectKeys.files(projectId ?? 'none'),
    queryFn: () => apiRequest<ProjectFileListResponse>(`/api/projects/${projectId ?? ''}/files`),
    enabled: projectId !== undefined,
    refetchInterval: (query) => (query.state.data?.stale === true ? 1_500 : false),
  });
}

export function useProjectBuilds(
  workspaceId: string | undefined,
  projectId?: string,
): UseQueryResult<ProjectBuildListResponse> {
  return useQuery({
    queryKey: projectKeys.builds(workspaceId ?? 'none', projectId),
    queryFn: () =>
      apiRequest<ProjectBuildListResponse>(
        `/api/workspaces/${workspaceId ?? ''}/projects/builds${
          projectId === undefined ? '' : `?projectId=${encodeURIComponent(projectId)}`
        }`,
      ),
    enabled: workspaceId !== undefined,
  });
}

/** One build, polled while it is still going. */
export function useProjectBuild(buildId: string | null): UseQueryResult<ProjectBuildResponse> {
  return useQuery({
    queryKey: projectKeys.build(buildId ?? 'none'),
    queryFn: () => apiRequest<ProjectBuildResponse>(`/api/project-builds/${buildId ?? ''}`),
    enabled: buildId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.build.status;
      return status === 'PENDING' || status === 'RUNNING' ? 1_500 : false;
    },
  });
}

export function useProjectBuildDiagnostics(
  buildId: string | null,
  enabled: boolean,
): UseQueryResult<ProjectBuildDiagnosticsResponse> {
  return useQuery({
    queryKey: projectKeys.diagnostics(buildId ?? 'none'),
    queryFn: () =>
      apiRequest<ProjectBuildDiagnosticsResponse>(
        `/api/project-builds/${buildId ?? ''}/diagnostics`,
      ),
    enabled: buildId !== null && enabled,
  });
}

/** The full build log. Only fetched when somebody asks to see it. */
export function useProjectBuildLog(
  buildId: string | null,
  enabled: boolean,
): UseQueryResult<ProjectBuildLogResponse> {
  return useQuery({
    queryKey: projectKeys.log(buildId ?? 'none'),
    queryFn: () => apiRequest<ProjectBuildLogResponse>(`/api/project-builds/${buildId ?? ''}/log`),
    enabled: buildId !== null && enabled,
  });
}

export function useProjectBuildArtifacts(
  buildId: string | null,
): UseQueryResult<ProjectBuildArtifactsResponse> {
  return useQuery({
    queryKey: projectKeys.artifacts(buildId ?? 'none'),
    queryFn: () =>
      apiRequest<ProjectBuildArtifactsResponse>(`/api/project-builds/${buildId ?? ''}/artifacts`),
    enabled: buildId !== null,
  });
}

export function useCreateProject(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateProjectInput) =>
      apiRequest<ProjectResponse>(`/api/workspaces/${workspaceId}/projects`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.list(workspaceId) });
      // The project is a document, so the sidebar tree gained a node too.
      void queryClient.invalidateQueries({ queryKey: ['workspace', workspaceId, 'tree'] });
    },
  });
}

export function useUpdateProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: UpdateProjectRequest) =>
      apiRequest<ProjectResponse>(`/api/projects/${projectId}`, {
        method: 'PATCH',
        body: request,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.project(projectId) });
    },
  });
}

/**
 * The four file mutations, as one hook.
 *
 * They differ in a path and a body and in nothing else that matters here: each
 * one goes to the API, the API hands it to the collaboration server, and the
 * tree is refetched. Four hooks would be four copies of the invalidation.
 */
export function useProjectFileMutation(projectId: string) {
  const queryClient = useQueryClient();
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: projectKeys.files(projectId) });
    void queryClient.invalidateQueries({ queryKey: projectKeys.project(projectId) });
  };

  const write = useMutation({
    mutationFn: (request: { path: string; content: string; createOnly?: boolean }) =>
      apiRequest<ProjectMutationResponse>(`/api/projects/${projectId}/files`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: invalidate,
  });

  const patch = useMutation({
    mutationFn: (request: PatchProjectFileRequest) =>
      apiRequest<ProjectMutationResponse>(`/api/projects/${projectId}/files/patch`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: invalidate,
  });

  const move = useMutation({
    mutationFn: (request: MoveProjectFileRequest) =>
      apiRequest<ProjectMutationResponse>(`/api/projects/${projectId}/files/move`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (request: DeleteProjectFileRequest) =>
      apiRequest<ProjectMutationResponse>(`/api/projects/${projectId}/files`, {
        method: 'DELETE',
        body: request,
      }),
    onSuccess: invalidate,
  });

  const addAsset = useMutation({
    mutationFn: (request: AddProjectAssetRequest) =>
      apiRequest<ProjectMutationResponse>(`/api/projects/${projectId}/assets`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: invalidate,
  });

  return { write, patch, move, remove, addAsset };
}

export function useStartProjectBuild(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: StartProjectBuildRequest) =>
      apiRequest<StartProjectBuildResponse>(`/api/projects/${projectId}/builds`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.build(result.build.id) });
    },
  });
}

/**
 * Deletes one finished build, its PDF and its SyncTeX map.
 *
 * Invalidates the list rather than the single build: the row has to disappear,
 * and the panel that may still be showing it is told by the caller, which is
 * the only place that knows whether it was looking at this one.
 */
export function useDeleteProjectBuild(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (buildId: string) =>
      apiRequest<DeleteProjectBuildResponse>(`/api/project-builds/${buildId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.builds(workspaceId, projectId) });
    },
  });
}

export function useCancelProjectBuild() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (buildId: string) =>
      apiRequest<ProjectBuildResponse>(`/api/project-builds/${buildId}/cancel`, { method: 'POST' }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: projectKeys.build(result.build.id) });
    },
  });
}
