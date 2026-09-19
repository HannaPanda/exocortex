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
import { queryKeys } from './queries';

export const databaseQueryKeys = {
  properties: (documentId: string) => ['database', documentId, 'properties'] as const,
  views: (documentId: string) => ['database', documentId, 'views'] as const,
  rows: (documentId: string, viewId: string | undefined) =>
    ['database', documentId, 'rows', viewId ?? 'default'] as const,
  /** A single row by its own document id, independent of its collection. */
  row: (rowId: string) => ['database', 'row', rowId] as const,
  /** Titles of the rows a RELATION property can point at. */
  relationTargets: (collectionId: string) =>
    ['database', collectionId, 'relation-targets'] as const,
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
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: databaseQueryKeys.views(documentId) }),
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
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: databaseQueryKeys.views(documentId) }),
  });
}

export function useDeleteDatabaseView(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (viewId: string) =>
      apiRequest<{ deleted: true }>(`/api/documents/${documentId}/views/${viewId}`, {
        method: 'DELETE',
      }),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: databaseQueryKeys.views(documentId) }),
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

/**
 * Rows of one calendar window, in as many requests as it takes.
 *
 * A calendar cannot page: a year view that showed the first hundred rows and
 * stopped would be wrong rather than incomplete, because the reader has no way
 * of telling which day lost its entries. So the window is narrowed server-side
 * with `overlaps` (the operator exists for exactly this) and the pages are
 * followed to the end.
 */
const CALENDAR_PAGE_SIZE = 100;

/**
 * Where following the pages stops. Ten pages is far more than a year of one
 * person's appointments and still a bounded number of requests, and the caller
 * is told when it was reached rather than being handed a silent truncation.
 */
const CALENDAR_MAX_PAGES = 10;

export interface CalendarRowsResult {
  rows: DatabaseRow[];
  /** `false` when `CALENDAR_MAX_PAGES` ran out before the rows did. */
  complete: boolean;
}

export function useDatabaseCalendarRows(input: {
  documentId: string;
  viewId: string;
  datePropertyId: string;
  from: string;
  to: string;
}) {
  const { documentId, viewId, datePropertyId, from, to } = input;
  return useQuery({
    queryKey: [...databaseQueryKeys.rows(documentId, viewId), 'calendar', datePropertyId, from, to],
    queryFn: async (): Promise<CalendarRowsResult> => {
      const rows: DatabaseRow[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < CALENDAR_MAX_PAGES; page += 1) {
        const request: QueryDatabaseRowsRequest = {
          viewId,
          limit: CALENDAR_PAGE_SIZE,
          cursor,
          filters: {
            combinator: 'and',
            conditions: [{ propertyId: datePropertyId, operator: 'overlaps', value: [from, to] }],
          },
        };
        const response = await apiRequest<QueryDatabaseRowsResponse>(
          `/api/documents/${documentId}/rows/query`,
          { method: 'POST', body: request },
        );
        rows.push(...response.rows);
        if (response.nextCursor === null) return { rows, complete: true };
        cursor = response.nextCursor;
      }
      return { rows, complete: false };
    },
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
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['database', documentId, 'rows'] });
      // The database's own detail carries `rowCount`, which the context panel
      // prints. Without this the panel keeps the number it was given when the
      // database was opened, so a freshly added row leaves it reading "0".
      void client.invalidateQueries({ queryKey: queryKeys.document(documentId) });
    },
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
      const response = await apiRequest<DocumentRowResponse>(
        `/api/documents/${documentId ?? ''}/row`,
      );
      return response.row;
    },
    enabled: documentId !== undefined,
  });
}

/**
 * How many rows of a linked database the relation picker offers at once.
 *
 * The API pages at 100, and a picker that has to scroll past several hundred
 * entries is the wrong shape for the problem anyway -- the honest fix for a
 * database that large is a search field, not a longer list. Until then the
 * limit is visible: the picker says when it is showing only the beginning.
 */
export const RELATION_PICKER_LIMIT = 100;

/**
 * The rows of a linked database, as id and title.
 *
 * A relation value is a list of ids and nothing else, which is what keeps it
 * from leaking anything: the titles come from this ordinary, authorized read
 * of the target database, so somebody who may not open it sees ids rather than
 * a name they were never shown.
 */
export function useRelationTargetRows(collectionId: string | undefined) {
  return useQuery({
    queryKey: databaseQueryKeys.relationTargets(collectionId ?? 'none'),
    queryFn: async () => {
      const response = await apiRequest<QueryDatabaseRowsResponse>(
        `/api/documents/${collectionId ?? ''}/rows/query`,
        { method: 'POST', body: { limit: RELATION_PICKER_LIMIT } },
      );
      return response.rows.map((row) => ({
        id: row.document.id,
        title: row.document.title,
        icon: row.document.icon,
      }));
    },
    enabled: collectionId !== undefined,
  });
}
