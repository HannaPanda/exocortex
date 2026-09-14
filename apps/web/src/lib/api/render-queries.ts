'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type CreateRenderTemplateRequest,
  type DeleteRenderJobResponse,
  type RenderJobListResponse,
  type RenderJobLogResponse,
  type RenderJobResponse,
  type RenderTemplateListResponse,
  type RenderTemplateResponse,
  type StartRenderRequest,
  type StartRenderResponse,
  type UpdateRenderTemplateRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * Render templates and the builds made with them (issue #44, ADR-026).
 *
 * A running build is polled rather than pushed at: `render.job.updated` exists
 * and the dialog subscribes to it, but a PDF that takes two minutes must also
 * finish for somebody whose socket dropped in the meantime. Polling stops as
 * soon as the job reaches a terminal status.
 */

export const renderKeys = {
  templates: (workspaceId: string) => ['workspace', workspaceId, 'render-templates'] as const,
  jobs: (workspaceId: string, documentId?: string) =>
    ['workspace', workspaceId, 'render-jobs', documentId ?? 'all'] as const,
  job: (jobId: string) => ['render-job', jobId] as const,
  log: (jobId: string) => ['render-job', jobId, 'log'] as const,
};

export function useRenderTemplates(
  workspaceId: string | undefined,
): UseQueryResult<RenderTemplateListResponse> {
  return useQuery({
    queryKey: renderKeys.templates(workspaceId ?? 'none'),
    queryFn: () =>
      apiRequest<RenderTemplateListResponse>(
        `/api/workspaces/${workspaceId ?? ''}/render/templates`,
      ),
    enabled: workspaceId !== undefined,
  });
}

export function useRenderJobs(
  workspaceId: string | undefined,
  documentId?: string,
): UseQueryResult<RenderJobListResponse> {
  return useQuery({
    queryKey: renderKeys.jobs(workspaceId ?? 'none', documentId),
    queryFn: () =>
      apiRequest<RenderJobListResponse>(
        `/api/workspaces/${workspaceId ?? ''}/render/jobs${
          documentId === undefined ? '' : `?documentId=${encodeURIComponent(documentId)}`
        }`,
      ),
    enabled: workspaceId !== undefined,
  });
}

/** One build, polled while it is still going. */
export function useRenderJob(jobId: string | null): UseQueryResult<RenderJobResponse> {
  return useQuery({
    queryKey: renderKeys.job(jobId ?? 'none'),
    queryFn: () => apiRequest<RenderJobResponse>(`/api/render/jobs/${jobId ?? ''}`),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      return status === 'PENDING' || status === 'RUNNING' ? 2_000 : false;
    },
  });
}

/** The full build log. Only fetched when somebody asks to see it. */
export function useRenderJobLog(
  jobId: string | null,
  enabled: boolean,
): UseQueryResult<RenderJobLogResponse> {
  return useQuery({
    queryKey: renderKeys.log(jobId ?? 'none'),
    queryFn: () => apiRequest<RenderJobLogResponse>(`/api/render/jobs/${jobId ?? ''}/log`),
    enabled: jobId !== null && enabled,
  });
}

export function useStartRender(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { documentId: string; request: StartRenderRequest }) =>
      apiRequest<StartRenderResponse>(`/api/documents/${input.documentId}/render`, {
        method: 'POST',
        body: input.request,
      }),
    onSuccess: (_response, input) => {
      if (workspaceId === undefined) return;
      void client.invalidateQueries({ queryKey: renderKeys.jobs(workspaceId, input.documentId) });
    },
  });
}

/**
 * Deletes one finished build and the PDF it produced.
 *
 * Invalidates the list rather than the single job: the row has to disappear,
 * and the panel that may still be showing the job is told by the caller, which
 * is the only place that knows whether it was looking at this one.
 */
export function useDeleteRender(workspaceId: string | undefined, documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      apiRequest<DeleteRenderJobResponse>(`/api/render/jobs/${jobId}`, { method: 'DELETE' }),
    onSuccess: () => {
      if (workspaceId === undefined) return;
      void client.invalidateQueries({ queryKey: renderKeys.jobs(workspaceId, documentId) });
    },
  });
}

export function useCancelRender() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      apiRequest<RenderJobResponse>(`/api/render/jobs/${jobId}/cancel`, { method: 'POST' }),
    onSuccess: (response) => {
      void client.invalidateQueries({ queryKey: renderKeys.job(response.job.id) });
    },
  });
}

export function useCreateRenderTemplate(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateRenderTemplateRequest) =>
      apiRequest<RenderTemplateResponse>(`/api/workspaces/${workspaceId ?? ''}/render/templates`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => {
      if (workspaceId === undefined) return;
      void client.invalidateQueries({ queryKey: renderKeys.templates(workspaceId) });
    },
  });
}

export function useUpdateRenderTemplate(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { templateId: string; request: UpdateRenderTemplateRequest }) =>
      apiRequest<RenderTemplateResponse>(`/api/render/templates/${input.templateId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: () => {
      if (workspaceId === undefined) return;
      void client.invalidateQueries({ queryKey: renderKeys.templates(workspaceId) });
    },
  });
}

export function useDeleteRenderTemplate(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (templateId: string) =>
      apiRequest<{ deleted: true }>(`/api/render/templates/${templateId}`, { method: 'DELETE' }),
    onSuccess: () => {
      if (workspaceId === undefined) return;
      void client.invalidateQueries({ queryKey: renderKeys.templates(workspaceId) });
    },
  });
}
