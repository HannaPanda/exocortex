'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  type CreateDatabasePropertyOptionRequest,
  type CreateDatabasePropertyRequest,
  type CreateDatabaseRowRequest,
  type CreateDatabaseViewRequest,
  type DatabaseProperty,
  type DatabasePropertyOption,
  type DatabaseRow,
  type DatabaseView,
  type DocumentRowResponse,
  type QueryDatabaseRowsRequest,
  type QueryDatabaseRowsResponse,
  type ReorderDatabasePropertyRequest,
  type ReorderDatabaseViewRequest,
  type UpdateDatabasePropertyOptionRequest,
  type UpdateDatabasePropertyRequest,
  type UpdateDatabaseRowValuesRequest,
  type UpdateDatabaseViewRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';

export const databaseQueryKeys = {
  properties: (documentId: string) => ['database', documentId, 'properties'] as const,
  views: (documentId: string) => ['database', documentId, 'views'] as const,
  rows: (documentId: string, viewId: string | undefined) =>
    ['database', documentId, 'rows', viewId ?? 'default'] as const,
  /** A single row by its own document id, independent of its collection. */
  row: (rowId: string) => ['database', 'row', rowId] as const,
};

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

export function useDatabaseProperties(documentId: string | undefined) {
  return useQuery({
    queryKey: databaseQueryKeys.properties(documentId ?? 'none'),
    queryFn: async () => {
      const response = await apiRequest<{ properties: DatabaseProperty[] }>(
        `/api/documents/${documentId ?? ''}/properties`,
      );
      return response.properties;
    },
    enabled: documentId !== undefined,
  });
}

function invalidateDatabase(client: ReturnType<typeof useQueryClient>, documentId: string): void {
  void client.invalidateQueries({ queryKey: databaseQueryKeys.properties(documentId) });
  void client.invalidateQueries({ queryKey: ['database', documentId, 'rows'] });
}

export function useCreateDatabaseProperty(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateDatabasePropertyRequest) =>
      apiRequest<DatabaseProperty>(`/api/documents/${documentId}/properties`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => invalidateDatabase(client, documentId),
  });
}

export function useUpdateDatabaseProperty(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { propertyId: string; request: UpdateDatabasePropertyRequest }) =>
      apiRequest<DatabaseProperty>(`/api/documents/${documentId}/properties/${input.propertyId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: () => invalidateDatabase(client, documentId),
  });
}

export function useReorderDatabaseProperty(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { propertyId: string; request: ReorderDatabasePropertyRequest }) =>
      apiRequest<DatabaseProperty>(
        `/api/documents/${documentId}/properties/${input.propertyId}/reorder`,
        { method: 'POST', body: input.request },
      ),
    onSuccess: () => invalidateDatabase(client, documentId),
  });
}

export function useDeleteDatabaseProperty(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (propertyId: string) =>
      apiRequest<{ deleted: true }>(`/api/documents/${documentId}/properties/${propertyId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => invalidateDatabase(client, documentId),
  });
}

export function useCreateDatabasePropertyOption(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { propertyId: string; request: CreateDatabasePropertyOptionRequest }) =>
      apiRequest<DatabasePropertyOption>(
        `/api/documents/${documentId}/properties/${input.propertyId}/options`,
        { method: 'POST', body: input.request },
      ),
    onSuccess: () => invalidateDatabase(client, documentId),
  });
}

export function useUpdateDatabasePropertyOption(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      propertyId: string;
      optionId: string;
      request: UpdateDatabasePropertyOptionRequest;
    }) =>
      apiRequest<DatabasePropertyOption>(
        `/api/documents/${documentId}/properties/${input.propertyId}/options/${input.optionId}`,
        { method: 'PATCH', body: input.request },
      ),
    onSuccess: () => invalidateDatabase(client, documentId),
  });
}

export function useDeleteDatabasePropertyOption(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { propertyId: string; optionId: string }) =>
      apiRequest<{ deleted: true }>(
        `/api/documents/${documentId}/properties/${input.propertyId}/options/${input.optionId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => invalidateDatabase(client, documentId),
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function useDatabaseViews(documentId: string | undefined) {
  return useQuery({
    queryKey: databaseQueryKeys.views(documentId ?? 'none'),
    queryFn: async () => {
      const response = await apiRequest<{ views: DatabaseView[] }>(
        `/api/documents/${documentId ?? ''}/views`,
      );
      return response.views;
    },
    enabled: documentId !== undefined,
  });
}

export function useCreateDatabaseView(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateDatabaseViewRequest) =>
      apiRequest<DatabaseView>(`/api/documents/${documentId}/views`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: databaseQueryKeys.views(documentId) }),
  });
}

export function useUpdateDatabaseView(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { viewId: string; request: UpdateDatabaseViewRequest }) =>
      apiRequest<DatabaseView>(`/api/documents/${documentId}/views/${input.viewId}`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: databaseQueryKeys.views(documentId) });
      void client.invalidateQueries({ queryKey: ['database', documentId, 'rows'] });
    },
  });
}

export function useReorderDatabaseView(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { viewId: string; request: ReorderDatabaseViewRequest }) =>
      apiRequest<DatabaseView>(`/api/documents/${documentId}/views/${input.viewId}/reorder`, {
        method: 'POST',
        body: input.request,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: databaseQueryKeys.views(documentId) }),
  });
}

export function useDeleteDatabaseView(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (viewId: string) =>
      apiRequest<{ deleted: true }>(`/api/documents/${documentId}/views/${viewId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: databaseQueryKeys.views(documentId) }),
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export function useDatabaseRows(documentId: string | undefined, request: QueryDatabaseRowsRequest) {
  return useQuery({
    queryKey: [...databaseQueryKeys.rows(documentId ?? 'none', request.viewId), request],
    queryFn: () =>
      apiRequest<QueryDatabaseRowsResponse>(`/api/documents/${documentId ?? ''}/rows/query`, {
        method: 'POST',
        body: request,
      }),
    enabled: documentId !== undefined,
  });
}

export function useCreateDatabaseRow(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateDatabaseRowRequest) =>
      apiRequest<DatabaseRow>(`/api/documents/${documentId}/rows`, {
        method: 'POST',
        body: request,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['database', documentId, 'rows'] }),
  });
}

export function useUpdateDatabaseRowValues(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { rowId: string; request: UpdateDatabaseRowValuesRequest }) =>
      apiRequest<DatabaseRow>(`/api/documents/${input.rowId}/values`, {
        method: 'PATCH',
        body: input.request,
      }),
    onSuccess: (_row, variables) => {
      void client.invalidateQueries({ queryKey: ['database', documentId, 'rows'] });
      // The row-peek sheet and the table view both read from `rows` above; the
      // context panel's properties tab reads a single row by its own id
      // instead (`useDocumentRow`), so it needs its own invalidation.
      void client.invalidateQueries({ queryKey: databaseQueryKeys.row(variables.rowId) });
    },
  });
}

/**
 * A single row by the id of the document it is (not by its collection): "is
 * this document a database row, and if so what are its values?" Used by the
 * context panel's properties tab (issue #17), which has an open document's id
 * and no reason to already know its collection.
 */
export function useDocumentRow(documentId: string | undefined) {
  return useQuery({
    queryKey: databaseQueryKeys.row(documentId ?? 'none'),
    queryFn: async () => {
      const response = await apiRequest<DocumentRowResponse>(`/api/documents/${documentId ?? ''}/row`);
      return response.row;
    },
    enabled: documentId !== undefined,
  });
}
