'use client';

import { HocuspocusProvider } from '@hocuspocus/provider';
import { type NodeViewProps } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import { FileHandler } from '@tiptap/extension-file-handler';
import { NodeRange } from '@tiptap/extension-node-range';
import { Placeholder } from '@tiptap/extension-placeholder';
import { type Editor, EditorContent, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import * as React from 'react';
import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  type DocumentSummary,
  type DocumentTreeNode,
} from '@exocortex/contracts';
import {
  type BlockCatalogEntry,
  BREADCRUMB_PATH_ATTRIBUTE,
  type BreadcrumbCrumb,
  buildBlockCatalog,
  buildEditorExtensions,
  DatabaseEmbed,
  YJS_DOCUMENT_FIELD,
} from '@exocortex/editor';
import { ErrorState, LoadingState } from '@exocortex/ui';

import { DatabaseEmbedNodeView } from '@/components/database/database-embed-node-view';
import { BlockHandle } from '@/components/editor/block-handle';
import { useBlockPrompt } from '@/components/editor/block-prompt';
import { CodeBlockToolbar } from '@/components/editor/code-block-toolbar';
import {
  type AskDatabaseEmbed,
  DatabaseEmbedPromptContext,
  type DatabaseEmbedSelection,
} from '@/components/editor/database-embed-context';
import {
  createMentionExtension,
  createMentionKeyboard,
  MentionMenu,
} from '@/components/editor/mention-menu';
import { SelectionToolbar } from '@/components/editor/selection-toolbar';
import {
  createSlashExtension,
  createSlashKeyboard,
  SlashMenu,
} from '@/components/editor/slash-menu';
import { type SuggestionKeyboard } from '@/components/editor/suggestion-menu';
import { TableToolbar } from '@/components/editor/table-toolbar';
import {
  presenceColor,
  type PresenceUser,
  useDocumentSession,
} from '@/components/shell/document-session';
import { attachmentMediaInfoResolver } from '@/lib/api/attachment-info';
import { fetchCollaborationTicket, uploadAttachment, useDocumentTree } from '@/lib/api/queries';

interface CollaborativeEditorProps {
  workspaceId: string;
  documentId: string;
  documentTitle: string;
  currentUser: { id: string; name: string };
  /** `read` disables all editing, e.g. for archived pages or guests. */
  access: 'read' | 'write';
  /** Ancestor path, read by the breadcrumb block. */
  breadcrumb: readonly BreadcrumbCrumb[];
}

interface Connection {
  provider: HocuspocusProvider;
  ydoc: Y.Doc;
  persistence: IndexeddbPersistence;
}

/** Depth-first flattening of the page tree, for the mention menu. */
function flattenTree(nodes: readonly DocumentTreeNode[]): DocumentSummary[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

/**
 * Picks the block type for an uploaded file from its MIME type.
 *
 * An image becomes an image, a video a player, everything else a download link:
 * the block a reader gets should match what the file actually is.
 */
function mediaNodeFor(
  mimeType: string,
  uploaded: { src: string; name: string },
): { type: string; attrs: Record<string, string> } {
  if (mimeType.startsWith('image/')) {
    return { type: 'image', attrs: { src: uploaded.src, alt: uploaded.name } };
  }
  if (mimeType.startsWith('video/')) {
    return { type: 'video', attrs: { src: uploaded.src, name: uploaded.name } };
  }
  if (mimeType.startsWith('audio/')) {
    return { type: 'audio', attrs: { src: uploaded.src, name: uploaded.name } };
  }
  if (mimeType === 'application/pdf') {
    return { type: 'pdf', attrs: { src: uploaded.src, name: uploaded.name } };
  }
  return { type: 'fileAttachment', attrs: { src: uploaded.src, name: uploaded.name } };
}

/**
 * How long a burst of typing has to be quiet before it counts as settled.
 * Yjs sends every update immediately; this only debounces the *display* of that
 * fact, so the indicator does not strobe while the user is writing.
 */
const SETTLE_DELAY_MS = 700;

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
  workspaceId,
  documentId,
  documentTitle,
  currentUser,
  access,
  breadcrumb,
}: CollaborativeEditorProps) {
  const { update } = useDocumentSession();
  const [connection, setConnection] = React.useState<Connection | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [synced, setSynced] = React.useState(false);

  // Connection setup. Re-runs only when the document changes.
  React.useEffect(() => {
    let disposed = false;
    let active: Connection | null = null;
    // Debounce for the save indicator; cleared on unmount.
    let settle: ReturnType<typeof setTimeout> | undefined;

    const connect = async (): Promise<void> => {
      setError(null);
      setSynced(false);
      update({
        documentId,
        documentTitle,
        collaboration: 'connecting',
        presence: [],
        saveState: 'idle',
        savedAt: null,
      });

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

      // Local edits drive both the offline flag and the save indicator. The
      // shell is only told twice per typing burst (once when it starts, once
      // when it settles) rather than on every keystroke, which would re-render
      // the whole application shell while the user types.
      let settling = false;
      ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
        if (origin === provider) return;
        if (!connected) {
          update({ pendingSync: true });
          return;
        }
        if (!settling) {
          settling = true;
          update({ saveState: 'saving' });
        }
        clearTimeout(settle);
        settle = setTimeout(() => {
          settling = false;
          update({ saveState: 'saved', savedAt: Date.now() });
        }, SETTLE_DELAY_MS);
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
      clearTimeout(settle);
      if (active !== null) {
        active.provider.destroy();
        void active.persistence.destroy();
        active.ydoc.destroy();
      }
      setConnection(null);
      update({
        documentId: null,
        presence: [],
        collaboration: 'connecting',
        saveState: 'idle',
        savedAt: null,
      });
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
      workspaceId={workspaceId}
      documentId={documentId}
      connection={connection}
      access={access}
      synced={synced}
      currentUser={currentUser}
      breadcrumb={breadcrumb}
    />
  );
}

interface EditorSurfaceProps {
  workspaceId: string;
  documentId: string;
  connection: Connection;
  access: 'read' | 'write';
  synced: boolean;
  currentUser: { id: string; name: string };
  breadcrumb: readonly BreadcrumbCrumb[];
}

/**
 * Creates the Tiptap instance, and nothing else.
 *
 * Split out twice over. From `CollaborativeEditor`, so the editor is built only
 * once the Yjs document exists — creating it earlier produces a document that is
 * later replaced, the classic source of hydration and duplicate-content bugs.
 *
 * And from `EditorChrome`, because **every render of this component reconfigures
 * the editor**: Tiptap re-applies its options after each render, which makes
 * ProseMirror rebuild every plugin view. A rebuilt plugin view drops an open
 * suggestion menu on the floor, and while the user types the save indicator alone
 * would trigger that twice per burst. So this component holds no state, reads no
 * query and subscribes to nothing; all of that lives in the chrome below.
 */
function EditorSurface({
  workspaceId,
  documentId,
  connection,
  access,
  synced,
  currentUser,
  breadcrumb,
}: EditorSurfaceProps) {
  // One catalog for the slash menu, the turn-into menu and the block menu.
  const catalog = React.useMemo(() => buildBlockCatalog(), []);

  /*
   * The suggestion plugins must exist before the editor and must never be
   * recreated. They only detect and handle keys; the menus render from the plugin
   * state (see `suggestion-menu.tsx`).
   */
  const slashKeyboard = React.useMemo(() => createSlashKeyboard(), []);
  const mentionKeyboard = React.useMemo(() => createMentionKeyboard(), []);
  const slashExtension = React.useMemo(() => createSlashExtension(slashKeyboard), [slashKeyboard]);
  const mentionExtension = React.useMemo(
    () => createMentionExtension(mentionKeyboard),
    [mentionKeyboard],
  );

  /**
   * Dropped and pasted files. Kept here rather than in the chrome because the
   * handler is part of the editor configuration; failures are reported through the
   * bridge-free callback below.
   */
  const [uploadError, setUploadError] = React.useState<string | null>(null);

  // Handed to `EditorChrome` below, which keeps it up to date; see
  // `database-embed-context.tsx` for why this needs to be a ref rather than a
  // plain context value.
  const askDatabaseEmbedRef = React.useRef<AskDatabaseEmbed | null>(null);
  const DatabaseEmbedView = React.useCallback(
    (props: NodeViewProps) => <DatabaseEmbedNodeView {...props} workspaceId={workspaceId} />,
    [workspaceId],
  );

  const insertFiles = React.useCallback(
    async (instance: Editor, files: File[], pos: number): Promise<void> => {
      let insertAt = pos;
      for (const file of files) {
        let uploaded: { src: string; name: string };
        try {
          uploaded = await uploadAttachment({ workspaceId, documentId, file });
        } catch {
          setUploadError('Eine Datei konnte nicht hochgeladen werden.');
          continue;
        }
        instance.chain().focus().insertContentAt(insertAt, mediaNodeFor(file.type, uploaded)).run();
        // Each inserted block shifts the following ones; append after the last.
        insertAt = instance.state.selection.to;
      }
    },
    [documentId, workspaceId],
  );

  const editor = useEditor(
    {
      // Rendering on the server would produce markup that differs from the
      // collaborative document.
      immediatelyRender: false,
      editable: access === 'write',
      extensions: buildEditorExtensions({
        // Lets the file and PDF blocks show what is inside them. The editor
        // package knows no routes, so the API side is injected here.
        mediaInfo: attachmentMediaInfoResolver,
        additionalExtensions: [
          // The schema for `databaseEmbed` lives in `packages/editor`; only the
          // React node view can live here (see `docs/editor-extensions.md`).
          DatabaseEmbed.extend({ addNodeView: () => ReactNodeViewRenderer(DatabaseEmbedView) }),
          Collaboration.configure({
            document: connection.ydoc,
            field: YJS_DOCUMENT_FIELD,
          }),
          CollaborationCaret.configure({
            provider: connection.provider,
            user: { name: currentUser.name, color: presenceColor(currentUser.id) },
          }),
          Placeholder.configure({
            placeholder: ({ node }) =>
              node.type.name === 'paragraph'
                ? 'Schreibe etwas oder tippe „/“ für Befehle …'
                : '',
            // Every empty block gets the hint, not only the first one.
            showOnlyCurrent: true,
            includeChildren: true,
          }),
          slashExtension,
          mentionExtension,
          // A peer requirement of the drag handle: dragging selects a whole node
          // range. Without it the handle is registered but never becomes visible,
          // because the plugin cannot resolve a range to grab.
          NodeRange,
          // Drag-and-drop and paste. The block type is chosen from the MIME type,
          // so dropping a video produces a player and not a broken image.
          FileHandler.configure({
            allowedMimeTypes: [...ALLOWED_ATTACHMENT_MIME_TYPES],
            onDrop: (instance, files, pos) => {
              void insertFiles(instance, files, pos);
            },
            onPaste: (instance, files) => {
              void insertFiles(instance, files, instance.state.selection.from);
            },
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
    [connection.ydoc, connection.provider, access, slashExtension, mentionExtension],
  );

  return (
    <div
      className="relative flex-1"
      {...{ [BREADCRUMB_PATH_ATTRIBUTE]: JSON.stringify(breadcrumb) }}
    >
      {!synced ? (
        <p className="absolute top-0 right-0 text-xs text-muted-foreground" role="status">
          wird synchronisiert …
        </p>
      ) : null}
      <DatabaseEmbedPromptContext.Provider value={askDatabaseEmbedRef}>
        <EditorContent editor={editor} className="exocortex-editor" />
      </DatabaseEmbedPromptContext.Provider>
      {uploadError === null ? null : (
        <p className="mt-2 text-xs text-destructive-text" role="alert">
          {uploadError}
        </p>
      )}
      {editor === null ? null : (
        <EditorChrome
          editor={editor}
          workspaceId={workspaceId}
          documentId={documentId}
          currentUser={currentUser}
          catalog={catalog}
          slashKeyboard={slashKeyboard}
          mentionKeyboard={mentionKeyboard}
          editable={access === 'write'}
          askDatabaseEmbedRef={askDatabaseEmbedRef}
        />
      )}
    </div>
  );
}

interface EditorChromeProps {
  editor: Editor;
  workspaceId: string;
  documentId: string;
  currentUser: { id: string; name: string };
  catalog: readonly BlockCatalogEntry[];
  slashKeyboard: SuggestionKeyboard;
  mentionKeyboard: SuggestionKeyboard;
  editable: boolean;
  askDatabaseEmbedRef: React.RefObject<AskDatabaseEmbed | null>;
}

/**
 * Everything around the editor that owns state: menus, toolbars, prompts.
 *
 * It re-renders freely — on every selection change, on every presence update, on
 * every save tick — precisely because `EditorSurface` above must not.
 */
function EditorChrome({
  editor,
  workspaceId,
  documentId,
  currentUser,
  catalog,
  slashKeyboard,
  mentionKeyboard,
  editable,
  askDatabaseEmbedRef,
}: EditorChromeProps) {
  /*
   * Mention sources, both from data the shell already holds so that typing `@`
   * costs no request: the page tree from the cache, and the people who are in this
   * document right now from the presence state.
   */
  const tree = useDocumentTree(workspaceId);
  const { state: session } = useDocumentSession();
  const mentionPages = React.useMemo(() => flattenTree(tree.data?.nodes ?? []), [tree.data]);
  const mentionUsers = React.useMemo(
    () =>
      [
        { id: currentUser.id, name: currentUser.name },
        ...session.presence
          .filter((user: PresenceUser) => !user.self)
          .map((user: PresenceUser) => ({ id: String(user.clientId), name: user.name })),
      ].filter((user, index, all) => all.findIndex((other) => other.name === user.name) === index),
    [currentUser.id, currentUser.name, session.presence],
  );

  const prompt = useBlockPrompt({ workspaceId, documentId });

  // Lets the database embed node view reopen this same picker ("Datenbank
  // wechseln") through the ref `EditorSurface` handed down; see
  // `database-embed-context.tsx`.
  React.useEffect(() => {
    askDatabaseEmbedRef.current = async () => {
      const raw = await prompt.ask('database');
      return raw === null ? null : (JSON.parse(raw) as DatabaseEmbedSelection);
    };
  }, [askDatabaseEmbedRef, prompt]);

  /**
   * Entries that need a value (an uploaded file, a formula) cannot collect it
   * themselves: `packages/editor` has no UI. The catalog declares what it needs,
   * this asks for it, and the entry runs with the answer.
   */
  const runEntry = React.useCallback(
    (entry: BlockCatalogEntry): void => {
      if (entry.prompt === 'none') {
        entry.run(editor);
        return;
      }
      void prompt.ask(entry.prompt).then((value) => {
        if (value === null) return;
        entry.run(editor, value);
      });
    },
    [editor, prompt],
  );

  return (
    <>
      {editable ? (
        <>
          <SelectionToolbar editor={editor} catalog={catalog} />
          <CodeBlockToolbar editor={editor} />
          <TableToolbar editor={editor} />
          <BlockHandle editor={editor} catalog={catalog} />
        </>
      ) : null}
      <SlashMenu
        editor={editor}
        keyboard={slashKeyboard}
        catalog={catalog}
        execute={runEntry}
      />
      <MentionMenu
        editor={editor}
        keyboard={mentionKeyboard}
        pages={mentionPages}
        users={mentionUsers}
      />
      {prompt.element}
    </>
  );
}
