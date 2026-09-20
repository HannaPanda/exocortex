/**
 * The query keys the frontend domains share.
 *
 * One definition rather than one per module: a key is only useful because two
 * places agree on it -- the module that reads it and the mutation elsewhere
 * that invalidates it. A domain whose keys nobody else touches keeps them in
 * its own file instead (`shareKeys`, `templateKeys` and the rest).
 */
export const queryKeys = {
  session: ['session'] as const,
  workspaces: ['workspaces'] as const,
  workspaceDetail: (workspaceId: string) => ['workspace', workspaceId, 'detail'] as const,
  documentTree: (workspaceId: string) => ['workspace', workspaceId, 'tree'] as const,
  workspaceOverview: (workspaceId: string) => ['workspace', workspaceId, 'overview'] as const,
  workspaceSettings: (workspaceId: string) => ['workspace', workspaceId, 'settings'] as const,
  workspaceCredentials: (workspaceId: string) => ['workspace', workspaceId, 'credentials'] as const,
  trash: (workspaceId: string) => ['workspace', workspaceId, 'trash'] as const,
  document: (documentId: string) => ['document', documentId] as const,
  search: (workspaceId: string, query: string) =>
    ['workspace', workspaceId, 'search', query] as const,
  documentLinks: (documentId: string) => ['document', documentId, 'links'] as const,
  documentActivity: (documentId: string) => ['document', documentId, 'activity'] as const,
  documentDiff: (documentId: string, snapshotId: string, against: string) =>
    ['document', documentId, 'diff', snapshotId, against] as const,
  documentRelated: (documentId: string) => ['document', documentId, 'related'] as const,
  /** Every resolved reference of a workspace; the prefix all of them share. */
  pageLinks: (workspaceId: string) => ['workspace', workspaceId, 'page-link'] as const,
  pageLink: (workspaceId: string, reference: { documentId?: string | null; title?: string }) =>
    [
      'workspace',
      workspaceId,
      'page-link',
      reference.documentId ?? '',
      (reference.title ?? '').toLowerCase(),
    ] as const,
  aiRun: (runId: string) => ['ai-run', runId] as const,
};
