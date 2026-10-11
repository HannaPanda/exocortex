'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type CancelEvalRunResponse,
  type CreateEvalCaseRequestInput,
  type DeleteEvalResponse,
  type EvalAttemptResponse,
  type EvalCaseFromRunRequest,
  type EvalCaseListResponse,
  type EvalCaseResponse,
  type EvalComparison,
  type EvalRunDetailResponse,
  type EvalRunListResponse,
  type ReviewEvalAttemptRequest,
  type StartEvalRunRequestInput,
  type UpdateEvalCaseRequestInput,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * Agent evals (issue #146, ADR-074).
 *
 * The run detail re-reads every few seconds while an attempt is open: the
 * attempts end in the worker and are settled by the API, and the realtime
 * event is the fast path, not the only one.
 */

export const evalKeys = {
  cases: (workspaceId: string) => ['workspace', workspaceId, 'eval-cases'] as const,
  case: (caseId: string) => ['eval-case', caseId] as const,
  runs: (workspaceId: string) => ['workspace', workspaceId, 'eval-runs'] as const,
  run: (evalRunId: string) => ['eval-run', evalRunId] as const,
  comparison: (runIds: readonly string[]) => ['eval-comparison', ...runIds] as const,
};

const OPEN_POLL_MS = 5_000;

export function useEvalCases(workspaceId: string): UseQueryResult<EvalCaseListResponse> {
  return useQuery({
    queryKey: evalKeys.cases(workspaceId),
    queryFn: () => apiRequest<EvalCaseListResponse>(`/api/workspaces/${workspaceId}/eval-cases`),
    staleTime: 30_000,
  });
}

export function useEvalCase(caseId: string): UseQueryResult<EvalCaseResponse> {
  return useQuery({
    queryKey: evalKeys.case(caseId),
    queryFn: () => apiRequest<EvalCaseResponse>(`/api/eval-cases/${caseId}`),
    staleTime: 15_000,
  });
}

export function useEvalRuns(workspaceId: string): UseQueryResult<EvalRunListResponse> {
  return useQuery({
    queryKey: evalKeys.runs(workspaceId),
    queryFn: () => apiRequest<EvalRunListResponse>(`/api/workspaces/${workspaceId}/eval-runs`),
    staleTime: 15_000,
  });
}

export function useEvalRun(evalRunId: string): UseQueryResult<EvalRunDetailResponse> {
  return useQuery({
    queryKey: evalKeys.run(evalRunId),
    queryFn: () => apiRequest<EvalRunDetailResponse>(`/api/eval-runs/${evalRunId}`),
    refetchInterval: (query) => (query.state.data?.run.finishedAt === null ? OPEN_POLL_MS : false),
  });
}

/** Several runs side by side; off until a second run is chosen. */
export function useEvalComparison(runIds: readonly string[]): UseQueryResult<EvalComparison> {
  return useQuery({
    queryKey: evalKeys.comparison(runIds),
    queryFn: () =>
      apiRequest<EvalComparison>(
        `/api/eval-comparison?runIds=${encodeURIComponent(runIds.join(','))}`,
      ),
    enabled: runIds.length > 1,
    staleTime: 15_000,
  });
}

function useInvalidateEvals(workspaceId: string) {
  const queryClient = useQueryClient();
  return (): void => {
    void queryClient.invalidateQueries({ queryKey: evalKeys.cases(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: evalKeys.runs(workspaceId) });
  };
}

export function useCreateEvalCase(workspaceId: string) {
  const invalidate = useInvalidateEvals(workspaceId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateEvalCaseRequestInput) =>
      apiRequest<EvalCaseResponse>(`/api/workspaces/${workspaceId}/eval-cases`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(evalKeys.case(response.evalCase.id), response);
      invalidate();
    },
  });
}

export function useUpdateEvalCase(workspaceId: string) {
  const invalidate = useInvalidateEvals(workspaceId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { caseId: string; request: UpdateEvalCaseRequestInput }) =>
      apiRequest<EvalCaseResponse>(`/api/eval-cases/${input.caseId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: evalKeys.case(response.evalCase.id) });
      invalidate();
    },
  });
}

export function useDeleteEvalCase(workspaceId: string) {
  const invalidate = useInvalidateEvals(workspaceId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (caseId: string) =>
      apiRequest<DeleteEvalResponse>(`/api/eval-cases/${caseId}`, { method: 'DELETE' }),
    onSuccess: (_response, caseId) => {
      queryClient.removeQueries({ queryKey: evalKeys.case(caseId) });
      invalidate();
    },
  });
}

export function useEvalCaseFromRun(workspaceId: string) {
  const invalidate = useInvalidateEvals(workspaceId);
  return useMutation({
    mutationFn: (input: { runId: string; request: EvalCaseFromRunRequest }) =>
      apiRequest<EvalCaseResponse>(`/api/ai/runs/${input.runId}/eval-case`, {
        method: 'POST',
        body: input.request,
      }),
    onSuccess: invalidate,
  });
}

export function useStartEvalRun(workspaceId: string) {
  const invalidate = useInvalidateEvals(workspaceId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: StartEvalRunRequestInput) =>
      apiRequest<EvalRunDetailResponse>(`/api/workspaces/${workspaceId}/eval-runs`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(evalKeys.run(response.run.id), response);
      invalidate();
    },
  });
}

export function useCancelEvalRun(workspaceId: string) {
  const invalidate = useInvalidateEvals(workspaceId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (evalRunId: string) =>
      apiRequest<CancelEvalRunResponse>(`/api/eval-runs/${evalRunId}/cancel`, { method: 'POST' }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: evalKeys.run(response.run.id) });
      invalidate();
    },
  });
}

export function useDeleteEvalRun(workspaceId: string) {
  const invalidate = useInvalidateEvals(workspaceId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (evalRunId: string) =>
      apiRequest<DeleteEvalResponse>(`/api/eval-runs/${evalRunId}`, { method: 'DELETE' }),
    onSuccess: (_response, evalRunId) => {
      queryClient.removeQueries({ queryKey: evalKeys.run(evalRunId) });
      invalidate();
    },
  });
}

export function useReviewEvalAttempt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { attemptId: string; request: ReviewEvalAttemptRequest }) =>
      apiRequest<EvalAttemptResponse>(`/api/eval-attempts/${input.attemptId}/review`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: evalKeys.run(response.attempt.evalRunId) });
      void queryClient.invalidateQueries({ queryKey: ['eval-comparison'] });
    },
  });
}
