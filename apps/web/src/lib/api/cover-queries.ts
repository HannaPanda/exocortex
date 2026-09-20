'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { type DocumentSummary, type GenerateDocumentCoverResponse } from '@exocortex/contracts';

import { apiRequest, uploadRequest } from './client';
import { queryKeys } from './query-keys';

/** Uploads a cover image and makes it the page's cover in one request. */
export function useUploadDocumentCover(workspaceId: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { documentId: string; file: File }) => {
      const form = new FormData();
      form.append('file', input.file, input.file.name);
      return uploadRequest<DocumentSummary>(`/api/documents/${input.documentId}/cover`, form);
    },
    onSuccess: (document) => {
      void client.invalidateQueries({ queryKey: queryKeys.document(document.id) });
      if (workspaceId !== undefined) {
        void client.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
      }
    },
  });
}

/**
 * Asks the AI to draw the page's cover.
 *
 * Resolves as soon as the job is queued, not when the picture exists. Nothing
 * is invalidated here on purpose: the finished cover arrives as a
 * `document.updated` event, and the outcome as `document.cover.generated`.
 */
export function useGenerateDocumentCover() {
  return useMutation({
    mutationFn: (input: { documentId: string; prompt: string }) =>
      apiRequest<GenerateDocumentCoverResponse>(
        `/api/documents/${input.documentId}/cover/generate`,
        { method: 'POST', body: { prompt: input.prompt } },
      ),
  });
}
