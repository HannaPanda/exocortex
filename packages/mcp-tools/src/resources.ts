import {
  documentTreeResponseSchema,
  markdownExportResponseSchema,
  type OverviewDocument,
  workspaceListResponseSchema,
  workspaceOverviewResponseSchema,
} from '@exocortex/contracts';

import { type ExocortexApiClient, ExocortexApiError } from './client.js';
import { renderTree } from './tools/page-render.js';

/**
 * MCP resources: the half of the protocol a human drives.
 *
 * A tool is something the model *calls*; a resource is something the person
 * sitting in front of the client *attaches* before the model thinks at all.
 * That difference is the whole point of this file. Until now the only way to
 * put a page in front of a model was to describe it in prose and hope the
 * model reached for `exo_page_read` with the right argument.
 *
 * Everything here goes through the REST API with the caller's own credential
 * (ADR-014/018), which is also the access check: `/api/workspaces` answers with
 * the workspaces this caller may read and nothing else, so a listing can never
 * name a page they cannot open. A page they may not read is not refused, it is
 * absent — the list must not leak a title.
 */

/** How many workspaces a listing walks before it stops. */
const MAX_LISTED_WORKSPACES = 20;

/** MCP `resources/list` entry. */
export interface McpResource {
  uri: string;
  /** Programmatic identifier. */
  name: string;
  /** What a client puts in its attach menu. */
  title: string;
  description?: string;
  mimeType: string;
}

/** MCP `resources/templates/list` entry. */
export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
}

/** One resource's content, as `resources/read` returns it. */
export interface McpResourceContents {
  contents: { uri: string; mimeType: string; text: string }[];
}

const MARKDOWN_MIME_TYPE = 'text/markdown';

/**
 * The addressable shapes of this deployment.
 *
 * Ids are cuid2-ish: letters and digits. The pattern is deliberately narrow so
 * a malformed URI is rejected here rather than travelling into a REST path.
 */
const PAGE_URI_PATTERN = /^exocortex:\/\/page\/([A-Za-z0-9_-]{1,64})$/;
const WORKSPACE_TREE_URI_PATTERN = /^exocortex:\/\/workspace\/([A-Za-z0-9_-]{1,64})\/tree$/;

export function pageResourceUri(documentId: string): string {
  return `exocortex://page/${documentId}`;
}

export function workspaceTreeResourceUri(workspaceId: string): string {
  return `exocortex://workspace/${workspaceId}/tree`;
}

export type ParsedResourceUri =
  { kind: 'page'; documentId: string } | { kind: 'workspace-tree'; workspaceId: string };

/** Parses one of this server's URIs, or `null` when it is none of them. */
export function parseResourceUri(uri: string): ParsedResourceUri | null {
  const page = PAGE_URI_PATTERN.exec(uri);
  if (page?.[1] !== undefined) {
    return { kind: 'page', documentId: page[1] };
  }
  const tree = WORKSPACE_TREE_URI_PATTERN.exec(uri);
  if (tree?.[1] !== undefined) {
    return { kind: 'workspace-tree', workspaceId: tree[1] };
  }
  return null;
}

/**
 * The URI patterns, so a client can address a page it found some other way.
 *
 * The listing below is short by design (the API names six recently edited pages
 * per workspace); the templates are what make the other several hundred
 * reachable, using an id from `exo_search` or `exo_page_tree`.
 */
export function listMcpResourceTemplates(): McpResourceTemplate[] {
  return [
    {
      uriTemplate: 'exocortex://page/{documentId}',
      name: 'page',
      title: 'Seite als Markdown',
      description:
        'Eine Seite dieses eXocortex als Markdown, mit ihrem Pfad und ihren direkten ' +
        'Unterseiten. Die documentId stammt aus exo_search, exo_page_tree oder der URL im Browser.',
      mimeType: MARKDOWN_MIME_TYPE,
    },
    {
      uriTemplate: 'exocortex://workspace/{workspaceId}/tree',
      name: 'workspace-tree',
      title: 'Seitenbaum eines Arbeitsbereichs',
      description:
        'Die Seitenhierarchie eines Arbeitsbereichs als eingerückte Liste, jede Zeile mit ihrer ' +
        'documentId. Bei vielen Seiten gekürzt. Die workspaceId nennt exo_list_workspaces.',
      mimeType: MARKDOWN_MIME_TYPE,
    },
  ];
}

/** "in Technik › Server" — a title alone is not an address. */
function describeLocation(document: OverviewDocument, workspaceName: string): string {
  const where = document.path.map((entry) => entry.title).join(' › ');
  return where === '' ? workspaceName : `${workspaceName}: ${where}`;
}

/**
 * Everything this caller may attach right now: one tree per readable
 * workspace, plus the pages they last worked on.
 *
 * A workspace whose overview fails is skipped rather than taking the whole
 * listing down with it. An attach menu missing one entry is a nuisance; an
 * attach menu that errors is a dead feature.
 */
export async function listMcpResources(client: ExocortexApiClient): Promise<McpResource[]> {
  const { workspaces } = await client.request({
    method: 'GET',
    path: '/api/workspaces',
    responseSchema: workspaceListResponseSchema,
  });
  const visible = workspaces.slice(0, MAX_LISTED_WORKSPACES);

  const resources: McpResource[] = visible.map((workspace) => ({
    uri: workspaceTreeResourceUri(workspace.id),
    name: `${workspace.slug}-tree`,
    title: `${workspace.name}: Seitenbaum`,
    description: `Die Seitenhierarchie von „${workspace.name}“ als eingerückte Liste.`,
    mimeType: MARKDOWN_MIME_TYPE,
  }));

  const overviews = await Promise.allSettled(
    visible.map(async (workspace) =>
      client.request({
        method: 'GET',
        path: `/api/workspaces/${workspace.id}/overview`,
        responseSchema: workspaceOverviewResponseSchema,
      }),
    ),
  );

  for (const overview of overviews) {
    if (overview.status !== 'fulfilled') continue;
    for (const document of overview.value.recentlyEdited) {
      resources.push({
        uri: pageResourceUri(document.id),
        name: document.id,
        title: document.title,
        description: describeLocation(document, overview.value.workspaceName),
        mimeType: MARKDOWN_MIME_TYPE,
      });
    }
  }

  return resources;
}

/**
 * Reads one resource, or `null` when it does not exist *for this caller*.
 *
 * A page somebody else owns and a page that was never created are the same
 * answer on purpose: anything else would turn `resources/read` into a way to
 * probe for ids. Only 403 and 404 collapse this way; a genuine failure keeps
 * being a failure, because "not found" would send the caller looking for a
 * mistake they did not make.
 */
export async function readMcpResource(
  client: ExocortexApiClient,
  uri: string,
): Promise<McpResourceContents | null> {
  const parsed = parseResourceUri(uri);
  if (parsed === null) return null;

  try {
    const text =
      parsed.kind === 'page'
        ? await readPage(client, parsed.documentId)
        : await readWorkspaceTree(client, parsed.workspaceId);
    return { contents: [{ uri, mimeType: MARKDOWN_MIME_TYPE, text }] };
  } catch (error) {
    if (error instanceof ExocortexApiError && (error.status === 403 || error.status === 404)) {
      return null;
    }
    throw error;
  }
}

async function readPage(client: ExocortexApiClient, documentId: string): Promise<string> {
  const result = await client.request({
    method: 'GET',
    path: `/api/documents/${documentId}/export/markdown`,
    responseSchema: markdownExportResponseSchema,
  });

  // The path and the children ride along for the same reason the Markdown
  // export carries them: a section page whose body reads as prose looks
  // complete, and a reader that gets only the body concludes the prose is the
  // structure. It is not; the children are.
  const header: string[] = [];
  if (result.path.length > 0) {
    header.push(`> Pfad: ${result.path.map((entry) => entry.title).join(' › ')}`);
  }
  if (result.children.length > 0) {
    header.push(
      `> Unterseiten: ${result.children.map((child) => `${child.title} (id: ${child.id})`).join(', ')}`,
    );
  }

  return header.length === 0 ? result.markdown : `${header.join('\n')}\n\n${result.markdown}`;
}

async function readWorkspaceTree(client: ExocortexApiClient, workspaceId: string): Promise<string> {
  const result = await client.request({
    method: 'GET',
    path: `/api/workspaces/${workspaceId}/documents/tree`,
    responseSchema: documentTreeResponseSchema,
  });
  const { lines, omitted } = renderTree(result.nodes);
  if (lines.length === 0) {
    return 'Keine Seiten vorhanden.';
  }
  // The caveat goes before the list it qualifies: a reader that stops
  // somewhere inside 300 lines never reaches a footer.
  const notice =
    omitted === 0
      ? []
      : [
          `> ${omitted} von ${result.totalCount} Seite(n) hier nicht angezeigt (gekürzt). ` +
            'Für einen vollständigen Zweig exo_page_tree mit der parentId der jeweiligen Seite aufrufen.',
          '',
        ];
  return [...notice, ...lines].join('\n');
}
