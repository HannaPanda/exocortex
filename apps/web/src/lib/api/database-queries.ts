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
  type DatabaseRowsResponse,
  type DatabaseSort,
  type DatabaseView,
  type DocumentRowResponse,
  type DuplicateDatabaseRowsResponse,
  type QueryDatabaseRowsRequest,
  type QueryDatabaseRowsResponse,
  type ReorderDatabasePropertyRequest,
  type ReorderDatabaseViewRequest,
  type TrashDatabaseRowsResponse,
  type UpdateDatabasePropertyOptionRequest,
  type UpdateDatabasePropertyRequest,
  type UpdateDatabaseRowsRequest,
  type UpdateDatabaseRowValuesRequest,
  type UpdateDatabaseViewRequest,
} from '@exocortex/contracts';

import { apiRequest } from './client';
import { queryKeys } from './query-keys';

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

/**
 * A view's order, written the moment it changes (issue #296).
 *
 * Optimistic on purpose: reordering by keyboard is several presses in a row,
 * and each one has to start from where the previous one left the list, not
 * from where the server last answered. So the new list goes into the views
 * cache synchronously, before the request is even queued, and every reader
 * (the sort bar, the column headers, the editor) shows it at once. The writes
 * of one view run one after another (`scope`), because each carries the whole
 * list and two of them overtaking each other would leave the older one stored;
 * only the last one to settle reads the server's answer back, so an earlier
 * answer never flickers over a newer intent. A refused write is corrected by
 * that same read.
 */
export function useUpdateDatabaseViewSorts(documentId: string, viewId: string) {
  const client = useQueryClient();
  const viewsKey = databaseQueryKeys.views(documentId);
  const mutationKey = ['database', documentId, 'view-sorts', viewId];
  const mutation = useMutation({
    mutationKey,
    scope: { id: `database-view-sorts-${viewId}` },
    mutationFn: (sorts: DatabaseSort[]) =>
      apiRequest<DatabaseView>(`/api/documents/${documentId}/views/${viewId}`, {
        method: 'PATCH',
        body: { sorts },
      }),
    onSettled: () => {
      // This mutation still counts as running while its own callback runs.
      if (client.isMutating({ mutationKey }) > 1) return;
      void client.invalidateQueries({ queryKey: viewsKey });
      void client.invalidateQueries({ queryKey: ['database', documentId, 'rows'] });
    },
  });

  return (sorts: DatabaseSort[]) => {
    void client.cancelQueries({ queryKey: viewsKey });
    client.setQueryData<DatabaseView[]>(viewsKey, (views) =>
      views?.map((entry) => (entry.id === viewId ? { ...entry, sorts } : entry)),
    );
    mutation.mutate(sorts);
  };
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
      // The table, board and gallery all read from `rows` above; the
      // context panel's properties tab reads a single row by its own id
      // instead (`useDocumentRow`), so it needs its own invalidation.
      void client.invalidateQueries({ queryKey: databaseQueryKeys.row(variables.rowId) });
    },
  });
}

/**
 * What changes when several rows changed at once (issue #244): the database's
 * rows, each row's own header, and -- for a duplicate or the trash -- the
 * database's row count.
 */
function invalidateAfterRowBatch(
  client: ReturnType<typeof useQueryClient>,
  documentId: string,
  structural: boolean,
): void {
  void client.invalidateQueries({ queryKey: ['database', documentId, 'rows'] });
  void client.invalidateQueries({ queryKey: ['database', 'row'] });
  if (!structural) return;
  // The sidebar's tree follows through the `document.*` events every row
  // created or archived announces.
  void client.invalidateQueries({ queryKey: queryKeys.document(documentId) });
}

/** The same values for every selected row, in one request. */
export function useUpdateDatabaseRows(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: UpdateDatabaseRowsRequest) =>
      apiRequest<DatabaseRowsResponse>(`/api/documents/${documentId}/rows/values`, {
        method: 'PATCH',
        body: request,
      }),
    onSuccess: () => invalidateAfterRowBatch(client, documentId, false),
  });
}

/** A copy of each row directly below it. */
export function useDuplicateDatabaseRows(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (rowIds: string[]) =>
      apiRequest<DuplicateDatabaseRowsResponse>(`/api/documents/${documentId}/rows/duplicate`, {
        method: 'POST',
        body: { rowIds },
      }),
    onSuccess: () => invalidateAfterRowBatch(client, documentId, true),
  });
}

/** The rows into the trash, each restorable on its own. */
export function useTrashDatabaseRows(documentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (rowIds: string[]) =>
      apiRequest<TrashDatabaseRowsResponse>(`/api/documents/${documentId}/rows/trash`, {
        method: 'POST',
        body: { rowIds },
      }),
    onSuccess: () => invalidateAfterRowBatch(client, documentId, true),
  });
}

/**
 * A single row by the id of the document it is (not by its collection): "is
 * this document a database row, and if so what are its values?", answered
 * together with the columns of its database. Used by the page header (issue
 * #254) and the context panel's properties tab (issue #17), which have an open
 * document's id and no reason to already know its collection -- and, on a page
 * shared on its own, no right to read that collection either.
 */
export function useDocumentRow(documentId: string | undefined) {
  return useQuery({
    queryKey: databaseQueryKeys.row(documentId ?? 'none'),
    queryFn: () => apiRequest<DocumentRowResponse>(`/api/documents/${documentId ?? ''}/row`),
    enabled: documentId !== undefined,
  });
}

/**
 * Keeps every open table, board, calendar and row header current while
 * somebody else changes the same database (issue #254).
 *
 * The API announces a changed row, column or view on the workspace channel;
 * this answers by marking what the browser holds about that database stale.
 * Only what is on screen is fetched again. A single row is invalidated across
 * the board rather than by id, because a rollup on one row is computed from
 * rows of another database, and an open page has exactly one of them.
 */
export function invalidateDatabaseAfterEvent(
  client: ReturnType<typeof useQueryClient>,
  event: { kind: 'row' | 'property' | 'view'; documentId: string },
): void {
  void client.invalidateQueries({ queryKey: ['database', event.documentId, 'rows'] });
  if (event.kind === 'view') {
    void client.invalidateQueries({ queryKey: databaseQueryKeys.views(event.documentId) });
    return;
  }
  if (event.kind === 'property') {
    void client.invalidateQueries({ queryKey: databaseQueryKeys.properties(event.documentId) });
  }
  void client.invalidateQueries({ queryKey: ['database', 'row'] });
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
