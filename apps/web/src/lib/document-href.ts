import { type DocumentType } from '@exocortex/contracts';

/**
 * Where a document lives in the browser.
 *
 * A project is a document (issue #43, ADR-027) but not a page: its screen is a
 * file tree, an editor and a PDF, not prose. One helper rather than a ternary
 * at each link, so a fourth document type is one change here instead of a hunt
 * through the sidebar, the search results and the trash.
 */
export function documentHref(workspaceId: string, documentId: string, type: DocumentType): string {
  const segment = type === 'PROJECT' ? 'projekt' : 'seite';
  return `/arbeitsbereich/${workspaceId}/${segment}/${documentId}`;
}
