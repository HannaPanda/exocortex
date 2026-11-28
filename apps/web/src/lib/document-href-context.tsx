'use client';

import * as React from 'react';

import { type DocumentType } from '@exocortex/contracts';

import { documentHref } from './document-href';

/**
 * Where a link to a page leads, depending on how the reader got here
 * (issue #327).
 *
 * A member reads a page at `/arbeitsbereich/<ws>/seite/<id>`. A recipient of a
 * share reads it at `/geteilt/<id>`, because the workspace address puts them in
 * front of a navigation, an inbox and a name that are all refused to them. A
 * link on a shared page to another page of the same share has to stay in the
 * shared view, or the second click of the reader leaves it.
 *
 * So the links of a page ask this context instead of building the workspace
 * address themselves. The shared view provides the other answer; everywhere
 * else the default is the workspace address, unchanged. Whether the target is
 * inside the share is not decided here: a page outside it answers the shared
 * view with the same refusal it gives everybody, and its title never reached
 * the browser in the first place.
 */
interface DocumentHrefs {
  /** The address of a page, built from its parts. */
  href: (workspaceId: string, documentId: string, type?: DocumentType) => string;
  /**
   * The same decision for an address that already exists as text: an internal
   * link in a page body or a section link, written as the workspace address.
   */
  rewrite: (path: string) => string;
}

const WORKSPACE_HREFS: DocumentHrefs = {
  href: (workspaceId, documentId, type = 'PAGE') => documentHref(workspaceId, documentId, type),
  rewrite: (path) => path,
};

/** `/arbeitsbereich/<ws>/seite/<id>` followed by an optional query or fragment. */
const WORKSPACE_PAGE_PATH = /^\/arbeitsbereich\/[^/?#]+\/seite\/([^/?#]+)([?#].*)?$/;

/** Exported for the test: the shared view's answer to a written address. */
export function sharedViewPath(path: string): string {
  const match = WORKSPACE_PAGE_PATH.exec(path);
  if (match === null) return path;
  return `/geteilt/${match[1] ?? ''}${match[2] ?? ''}`;
}

const SHARED_HREFS: DocumentHrefs = {
  // A project has a screen of its own that the shared view does not draw, so
  // it keeps its address; everything else is read as a shared page.
  href: (workspaceId, documentId, type = 'PAGE') =>
    type === 'PROJECT' ? documentHref(workspaceId, documentId, type) : `/geteilt/${documentId}`,
  rewrite: sharedViewPath,
};

const DocumentHrefContext = React.createContext<DocumentHrefs>(WORKSPACE_HREFS);

/** Wraps the shared view: every page link inside it stays in the shared view. */
export function SharedDocumentHrefs({ children }: { children: React.ReactNode }) {
  return (
    <DocumentHrefContext.Provider value={SHARED_HREFS}>{children}</DocumentHrefContext.Provider>
  );
}

export function useDocumentHrefs(): DocumentHrefs {
  return React.useContext(DocumentHrefContext);
}
