'use client';

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import {
  type AutomationRuleListResponse,
  type AutomationRuleResponse,
  type AutomationRunListResponse,
  type CreateAutomationRuleRequest,
  type CreateAutomationRuleResponse,
  type TriggerAutomationRuleRequest,
  type TriggerAutomationRuleResponse,
  type UpdateAutomationRuleRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';

/**
 * Automation rules and their run log (issue #50, ADR-024).
 *
 * Its own file rather than more lines in `queries.ts`: automations are reached
 * from one page, and everything about them -- two lists, four mutations -- is
 * easier to read together than scattered through the shared file.
 */

export const automationKeys = {
  rules: (workspaceId: string) => ['workspace', workspaceId, 'automations'] as const,
  runs: (workspaceId: string, ruleId?: string) =>
    ['workspace', workspaceId, 'automation-runs', ruleId ?? 'all'] as const,
};

export function useAutomationRules(
  workspaceId: string | undefined,
): UseQueryResult<AutomationRuleListResponse> {
  return useQuery({
    queryKey: automationKeys.rules(workspaceId ?? 'none'),
    queryFn: () =>
      apiRequest<AutomationRuleListResponse>(`/api/workspaces/${workspaceId ?? ''}/automations`),
    enabled: workspaceId !== undefined,
  });
}

/**
 * The run log.
 *
 * Polled while the page is open: a run finishes in a worker, seconds after
 * somebody pressed "jetzt ausführen", and there is no realtime event for it on
 * purpose (an automation usually runs with nobody watching, so a channel for it
 * would be a channel that is almost always silent).
 */
export function useAutomationRuns(
  workspaceId: string | undefined,
  ruleId?: string,
): UseQueryResult<AutomationRunListResponse> {
  return useQuery({
    queryKey: automationKeys.runs(workspaceId ?? 'none', ruleId),
    queryFn: () =>
      apiRequest<AutomationRunListResponse>(
        `/api/workspaces/${workspaceId ?? ''}/automations/runs${
          ruleId === undefined ? '' : `?ruleId=${encodeURIComponent(ruleId)}`
        }`,
      ),
    enabled: workspaceId !== undefined,
    refetchInterval: 10_000,
  });
}

export function useCreateAutomationRule(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateAutomationRuleRequest) =>
      apiRequest<CreateAutomationRuleResponse>(`/api/workspaces/${workspaceId ?? ''}/automations`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => {
      if (workspaceId === undefined) return;
      void client.invalidateQueries({ queryKey: automationKeys.rules(workspaceId) });
    },
  });
}

export function useUpdateAutomationRule(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { ruleId: string; request: UpdateAutomationRuleRequest }) =>
      apiRequest<AutomationRuleResponse>(`/api/automations/${input.ruleId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: () => {
      if (workspaceId === undefined) return;
      void client.invalidateQueries({ queryKey: automationKeys.rules(workspaceId) });
    },
  });
}

export function useDeleteAutomationRule(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ruleId: string) =>
      apiRequest<{ deleted: true }>(`/api/automations/${ruleId}`, { method: 'DELETE' }),
    onSuccess: () => {
      if (workspaceId === undefined) return;
      void client.invalidateQueries({ queryKey: automationKeys.rules(workspaceId) });
    },
  });
}

export function useTriggerAutomationRule(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { ruleId: string; request: TriggerAutomationRuleRequest }) =>
      apiRequest<TriggerAutomationRuleResponse>(`/api/automations/${input.ruleId}/trigger`, {
        method: 'POST',
        body: input.request,
      }),
    onSuccess: (_response, input) => {
      if (workspaceId === undefined) return;
      // The run is queued, not finished. Invalidating now shows it as PENDING,
      // and the log's own polling brings the result a moment later.
      void client.invalidateQueries({ queryKey: automationKeys.runs(workspaceId) });
      void client.invalidateQueries({ queryKey: automationKeys.runs(workspaceId, input.ruleId) });
    },
  });
}
