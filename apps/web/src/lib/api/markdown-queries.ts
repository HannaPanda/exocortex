'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { type MarkdownExportResponse, type MarkdownImportResponse } from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

export function useExportMarkdown() {
  return useMutation({
    mutationFn: (documentId: string) =>
      apiRequest<MarkdownExportResponse>(`/api/documents/${documentId}/export/markdown`),
  });
}

export function useImportMarkdown(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { markdown: string; title?: string; parentId?: string | null }) =>
      apiRequest<MarkdownImportResponse>(`/api/workspaces/${workspaceId ?? ''}/import/markdown`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => {
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}
