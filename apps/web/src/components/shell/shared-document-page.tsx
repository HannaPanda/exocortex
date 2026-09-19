'use client';

import { ErrorState, LoadingState } from '@exocortex/ui';

import { useDocument } from '@/lib/api/queries';

import { DocumentView } from './document-view';

/**
 * A page somebody shared with this account (issue #83, ADR-044).
 *
 * Its own address rather than the workspace one, because the reader is not a
 * member of that workspace: `/arbeitsbereich/<id>/seite/<id>` would put them in
 * front of a navigation tree, an inbox and a workspace name that are all
 * refused to them. The editor itself is the same one, with the same rights the
 * grant carries, which is what makes a WRITE share mean writing rather than
 * commenting.
 *
 * The workspace id comes out of the page instead of out of the address, so
 * nothing here has to be told which workspace the page lives in -- and a reader
 * who pastes a document id they hold no grant for gets the same refusal as
 * anyone else.
 */
export function SharedDocumentPage({ documentId }: { documentId: string }) {
  const document = useDocument(documentId);

  if (document.isPending) return <LoadingState label="Seite wird geladen …" />;
  if (document.isError || document.data === undefined) {
    return (
      <ErrorState
        title="Seite nicht verfügbar"
        description="Die Freigabe wurde zurückgezogen, ist abgelaufen, oder es gab sie nie."
        onRetry={() => void document.refetch()}
      />
    );
  }

  return <DocumentView workspaceId={document.data.workspaceId} documentId={documentId} />;
}
