'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type CancelWorkflowRunRequest,
  type CreateWorkflowRequest,
  type DeleteWorkflowResponse,
  type PublishWorkflowResponse,
  type StartWorkflowRunRequest,
  type UpdateWorkflowRequest,
  WORKFLOW_RUN_TERMINAL_STATUSES,
  type WorkflowListResponse,
  type WorkflowResponse,
  type WorkflowRunListResponse,
  type WorkflowRunResponse,
  type WorkflowRunStartResponse,
  type WorkflowVersionListResponse,
  type WorkflowVersionResponse,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * Agent workflows in the browser (issue #164).
 *
 * Saving answers with the whole workflow, so the detail cache is written from
 * the answer rather than refetched: the editor compares its local draft with
 * what the server holds, and a refetch in between would make an unsaved
 * change look saved. A run is read again every few seconds while it has not
 * finished, because it moves in the worker and nothing pushes its steps here.
 */

export const workflowKeys = {
  list: (workspaceId: string) => ['workspace', workspaceId, 'workflows'] as const,
  detail: (workflowId: string) => ['workflow', workflowId] as const,
  versions: (workflowId: string) => ['workflow', workflowId, 'versions'] as const,
  runs: (workflowId: string) => ['workflow', workflowId, 'runs'] as const,
  run: (runId: string) => ['workflow-run', runId] as const,
};

const ACTIVE_RUN_POLL_MS = 3_000;

export function useWorkflows(workspaceId: string): UseQueryResult<WorkflowListResponse> {
  return useQuery({
    queryKey: workflowKeys.list(workspaceId),
    queryFn: () => apiRequest<WorkflowListResponse>(`/api/workspaces/${workspaceId}/workflows`),
    staleTime: 15_000,
  });
}

export function useWorkflow(workflowId: string): UseQueryResult<WorkflowResponse> {
  return useQuery({
    queryKey: workflowKeys.detail(workflowId),
    queryFn: () => apiRequest<WorkflowResponse>(`/api/workflows/${workflowId}`),
    staleTime: 30_000,
    // A draft somebody is editing must not be swapped underneath them.
    refetchOnWindowFocus: false,
  });
}

export function useWorkflowVersions(
  workflowId: string,
  enabled: boolean,
): UseQueryResult<WorkflowVersionListResponse> {
  return useQuery({
    queryKey: workflowKeys.versions(workflowId),
    queryFn: () => apiRequest<WorkflowVersionListResponse>(`/api/workflows/${workflowId}/versions`),
    enabled,
  });
}

export function useWorkflowRuns(workflowId: string): UseQueryResult<WorkflowRunListResponse> {
  return useQuery({
    queryKey: workflowKeys.runs(workflowId),
    queryFn: () => apiRequest<WorkflowRunListResponse>(`/api/workflows/${workflowId}/runs`),
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => !WORKFLOW_RUN_TERMINAL_STATUSES.includes(run.status))
        ? ACTIVE_RUN_POLL_MS * 2
        : false,
  });
}

export function useWorkflowRun(runId: string): UseQueryResult<WorkflowRunResponse> {
  return useQuery({
    queryKey: workflowKeys.run(runId),
    queryFn: () => apiRequest<WorkflowRunResponse>(`/api/workflow-runs/${runId}`),
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === undefined || WORKFLOW_RUN_TERMINAL_STATUSES.includes(status)
        ? false
        : ACTIVE_RUN_POLL_MS;
    },
  });
}

export function useCreateWorkflow(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateWorkflowRequest) =>
      apiRequest<WorkflowResponse>(`/api/workspaces/${workspaceId}/workflows`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: (response) => {
      client.setQueryData(workflowKeys.detail(response.workflow.id), response);
      void client.invalidateQueries({ queryKey: workflowKeys.list(workspaceId) });
    },
  });
}

export function useUpdateWorkflow(workspaceId: string, workflowId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: UpdateWorkflowRequest) =>
      apiRequest<WorkflowResponse>(`/api/workflows/${workflowId}`, {
        method: 'PATCH',
        body: request,
      }),
    onSuccess: (response) => {
      client.setQueryData(workflowKeys.detail(workflowId), response);
      void client.invalidateQueries({ queryKey: workflowKeys.list(workspaceId) });
    },
  });
}

export function usePublishWorkflow(workspaceId: string, workflowId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (expectedRevision: number) =>
      apiRequest<PublishWorkflowResponse>(`/api/workflows/${workflowId}/publish`, {
        method: 'POST',
        body: { expectedRevision },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: workflowKeys.detail(workflowId) });
      void client.invalidateQueries({ queryKey: workflowKeys.versions(workflowId) });
      void client.invalidateQueries({ queryKey: workflowKeys.list(workspaceId) });
    },
  });
}

export function useSetWorkflowActivation(workspaceId: string, workflowId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest<WorkflowResponse>(`/api/workflows/${workflowId}/activation`, {
        method: 'POST',
        body: { enabled },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: workflowKeys.detail(workflowId) });
      void client.invalidateQueries({ queryKey: workflowKeys.list(workspaceId) });
    },
  });
}

/** Copies a draft into a new workflow (issue #165); the copy is a draft and nothing more. */
export function useDuplicateWorkflow(workspaceId: string, workflowId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest<WorkflowResponse>(`/api/workflows/${workflowId}/duplicate`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (response) => {
      client.setQueryData(workflowKeys.detail(response.workflow.id), response);
      void client.invalidateQueries({ queryKey: workflowKeys.list(workspaceId) });
    },
  });
}

export function useDeleteWorkflow(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (workflowId: string) =>
      apiRequest<DeleteWorkflowResponse>(`/api/workflows/${workflowId}`, { method: 'DELETE' }),
    onSuccess: (_response, workflowId) => {
      client.removeQueries({ queryKey: workflowKeys.detail(workflowId) });
      void client.invalidateQueries({ queryKey: workflowKeys.list(workspaceId) });
    },
  });
}

export function useStartWorkflowRun(workflowId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: StartWorkflowRunRequest) =>
      apiRequest<WorkflowRunStartResponse>(`/api/workflows/${workflowId}/runs`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: workflowKeys.runs(workflowId) });
      void client.invalidateQueries({ queryKey: workflowKeys.detail(workflowId) });
    },
  });
}

export function useCancelWorkflowRun(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CancelWorkflowRunRequest) =>
      apiRequest<WorkflowRunResponse>(`/api/workflow-runs/${runId}/cancel`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: (response) => {
      client.setQueryData(workflowKeys.run(runId), response);
      void client.invalidateQueries({ queryKey: workflowKeys.runs(response.run.workflowId) });
    },
  });
}

/** One published version with its graph; the test run starts from its triggers. */
export function useWorkflowVersion(
  versionId: string | undefined,
): UseQueryResult<WorkflowVersionResponse> {
  return useQuery({
    queryKey: ['workflow-version', versionId ?? 'none'],
    queryFn: () => apiRequest<WorkflowVersionResponse>(`/api/workflow-versions/${versionId ?? ''}`),
    enabled: versionId !== undefined,
    // A version never changes.
    staleTime: Infinity,
  });
}
