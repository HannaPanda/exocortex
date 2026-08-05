'use client';

import { HocuspocusProvider } from '@hocuspocus/provider';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import { Placeholder } from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import * as React from 'react';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

import { buildEditorExtensions, YJS_DOCUMENT_FIELD } from '@exocortex/editor';
import { ErrorState, LoadingState } from '@exocortex/ui';

import {
  presenceColor,
  type PresenceUser,
  useDocumentSession,
} from '@/components/shell/document-session';
import { fetchCollaborationTicket } from '@/lib/api/queries';

interface CollaborativeEditorProps {
  documentId: string;
  documentTitle: string;
  currentUser: { id: string; name: string };
  /** `read` disables all editing, e.g. for archived pages or guests. */
  access: 'read' | 'write';
}

interface Connection {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  persistence: IndexeddbPersistence;
}

/**
 * Collaborative Tiptap editor.
 *
 * Architecture:
 *  * the Yjs document is the canonical state; Tiptap is only a view on it
 *  * one Yjs document per Exocortex document (never one per workspace)
 *  * `y-indexeddb` keeps edits while offline and replays them after reconnect
 *  * the connection is authorized with a short-lived, per-document ticket; the
 *    session cookie is never handed to the collaboration server
 *  * all extensions come from `@exocortex/editor`; no schema is defined here
 */
export function CollaborativeEditor({
  documentId,
  documentTitle,
  currentUser,
  access,
}: CollaborativeEditorProps) {
  const { update } = useDocumentSession();
  const [connection, setConnection] = React.useState<Connection | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [synced, setSynced] = React.useState(false);

  // Connection setup. Re-runs only when the document changes.
  React.useEffect(() => {
    let disposed = false;
    let active: Connection | null = null;

    const connect = async (): Promise<void> => {
      setError(null);
      setSynced(false);
      update({ documentId, documentTitle, collaboration: 'connecting', presence: [] });

      let ticket: Awaited<ReturnType<typeof fetchCollaborationTicket>>;
      try {
        ticket = await fetchCollaborationTicket(documentId);
      } catch {
        if (!disposed) setError('Die Live-Bearbeitung konnte nicht gestartet werden.');
        return;
      }
      if (disposed) return;

      const ydoc = new Y.Doc();
      // Offline persistence: the local copy is available before the socket opens.
      const persistence = new IndexeddbPersistence(`exocortex:${documentId}`, ydoc);

      // The provider does not expose a connection flag, so the last reported
      // status is tracked locally to decide whether local edits are pending.
      let connected = false;

      const provider = new HocuspocusProvider({
        url: ticket.collaborationUrl,
        name: ticket.documentName,
        document: ydoc,
        token: ticket.ticket,
        onStatus: ({ status }) => {
          connected = status === 'connected';
          update({
            collaboration:
              status === 'connected'
                ? ticket.access === 'read'
                  ? 'read-only'
                  : 'connected'
                : status === 'connecting'
                  ? 'connecting'
                  : 'disconnected',
          });
        },
        onSynced: () => {
          setSynced(true);
          update({ pendingSync: false });
        },
        onDisconnect: () => {
          connected = false;
          update({ collaboration: 'disconnected' });
        },
      });

      // While disconnected, local updates are unsynchronized by definition.
      ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
        if (origin === provider) return;
        if (!connected) update({ pendingSync: true });
      });

      provider.awareness?.setLocalStateField('user', {
        name: currentUser.name,
        color: presenceColor(currentUser.id),
      });

      const readPresence = (): void => {
        const states = provider.awareness?.getStates();
        if (states === undefined) return;
        const users: PresenceUser[] = [];
        for (const [clientId, state] of states) {
          const user = (state as { user?: { name?: string; color?: string } }).user;
          if (user === undefined) continue;
          users.push({
            clientId,
            name: user.name ?? 'Unbekannt',
            color: user.color ?? presenceColor(String(clientId)),
            self: clientId === provider.awareness?.clientID,
          });
        }
        update({ presence: users });
      };

      provider.awareness?.on('change', readPresence);
      readPresence();

      active = { provider, ydoc, persistence };
      if (disposed) {
        provider.destroy();
        void persistence.destroy();
        ydoc.destroy();
        return;
      }
      setConnection(active);
    };

    void connect();

    return () => {
      disposed = true;
      if (active !== null) {
        active.provider.destroy();
        void active.persistence.destroy();
        active.ydoc.destroy();
      }
      setConnection(null);
      update({ documentId: null, presence: [], collaboration: 'connecting' });
    };
    // `update` is stable (useCallback in the provider).
  }, [currentUser.id, currentUser.name, documentId, documentTitle, update]);

  if (error !== null) {
    return <ErrorState title="Editor nicht verfügbar" description={error} />;
  }
  if (connection === null) {
    return <LoadingState label="Editor wird verbunden …" />;
  }

  return (
    <EditorSurface
      key={documentId}
      connection={connection}
      access={access}
      synced={synced}
      currentUser={currentUser}
    />
  );
}

interface EditorSurfaceProps {
  connection: Connection;
  access: 'read' | 'write';
  synced: boolean;
  currentUser: { id: string; name: string };
}

/**
 * Split out so the Tiptap instance is created only once the Yjs document exists.
 * Creating the editor before that would produce a document that is later
 * replaced, which is the classic source of hydration and duplicate-content bugs.
 */
function EditorSurface({ connection, access, synced, currentUser }: EditorSurfaceProps) {
  const editor = useEditor(
    {
      // Rendering on the server would produce markup that differs from the
      // collaborative document.
      immediatelyRender: false,
      editable: access === 'write',
      extensions: buildEditorExtensions({
        additionalExtensions: [
          Collaboration.configure({
            document: connection.ydoc,
            field: YJS_DOCUMENT_FIELD,
          }),
          CollaborationCaret.configure({
            provider: connection.provider,
            user: { name: currentUser.name, color: presenceColor(currentUser.id) },
          }),
          Placeholder.configure({
            placeholder: 'Schreibe etwas oder tippe „/“ für Befehle …',
          }),
        ],
      }),
      editorProps: {
        attributes: {
          class: 'exocortex-editor',
          'data-testid': 'editor-surface',
          'aria-label': 'Seiteninhalt',
        },
      },
    },
    [connection.ydoc, connection.provider, access],
  );

  return (
    <div className="relative flex-1">
      {!synced ? (
        <p className="absolute top-0 right-0 text-xs text-muted-foreground" role="status">
          wird synchronisiert …
        </p>
      ) : null}
      <EditorContent editor={editor} className="exocortex-editor" />
    </div>
  );
}
