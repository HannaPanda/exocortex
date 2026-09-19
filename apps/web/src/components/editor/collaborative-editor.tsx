'use client';

import { type NodeViewProps } from '@tiptap/core';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import { FileHandler } from '@tiptap/extension-file-handler';
import { NodeRange } from '@tiptap/extension-node-range';
import { Placeholder } from '@tiptap/extension-placeholder';
import { type Mark as PmMark, type Node as PmNode } from '@tiptap/pm/model';
import { type EditorView } from '@tiptap/pm/view';
import { type Editor, EditorContent, ReactNodeViewRenderer, useEditor } from '@tiptap/react';
import * as React from 'react';

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
  type LinkTarget,
  PageLink,
  parseLinkHref,
  SavedQueryEmbed,
  YJS_DOCUMENT_FIELD,
} from '@exocortex/editor';
import { ErrorState, LoadingState } from '@exocortex/ui';

import { DatabaseEmbedNodeView } from '@/components/database/database-embed-node-view';
import { BlockHandle } from '@/components/editor/block-handle';
import { useBlockPrompt } from '@/components/editor/block-prompt';
import { CodeBlockToolbar } from '@/components/editor/code-block-toolbar';
import {
  type Connection,
  useCollaborationConnection,
} from '@/components/editor/collaboration-connection';
import { CommentMarkers, createCommentMarkers } from '@/components/editor/comment-markers';
import {
  type AskDatabaseEmbed,
  DatabaseEmbedPromptContext,
  type DatabaseEmbedSelection,
} from '@/components/editor/database-embed-context';
import { type FollowLink, FollowLinkContext } from '@/components/editor/follow-link-context';
import { LinkBubble } from '@/components/editor/link-bubble';
import { useLinkNavigation } from '@/components/editor/link-navigation';
import {
  createMentionExtension,
  createMentionKeyboard,
  MentionMenu,
} from '@/components/editor/mention-menu';
import {
  type AskPageLink,
  PageLinkPromptContext,
  type PageLinkSelection,
} from '@/components/editor/page-link-context';
import { PageLinkNodeView } from '@/components/editor/page-link-node-view';
import { SelectionToolbar } from '@/components/editor/selection-toolbar';
import {
  createSlashExtension,
  createSlashKeyboard,
  SlashMenu,
} from '@/components/editor/slash-menu';
import { type SuggestionKeyboard } from '@/components/editor/suggestion-menu';
import { TableToolbar } from '@/components/editor/table-toolbar';
import { createWikiLinkMarkers, WikiLinkMarkers } from '@/components/editor/wiki-link-markers';
import { SavedQueryNodeView } from '@/components/search/saved-query-node-view';
import {
  presenceColor,
  type PresenceUser,
  useDocumentSession,
} from '@/components/shell/document-session';
import { attachmentMediaInfoResolver } from '@/lib/api/attachment-info';
import { uploadAttachment, useDocumentTree } from '@/lib/api/queries';

import {
  type AskSavedQueryEmbed,
  SavedQueryEmbedPromptContext,
  type SavedQueryEmbedSelection,
} from './saved-query-embed-context';

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
 * Puts the identity a `[[Titel]]` mark carries back onto the parsed target.
 *
 * `parseLinkHref` only ever sees the address, and a wiki address is a title
 * (issue #24 keeps it that way: an exported file contains no internal ids).
 * The identity lives next to it, in the mark's `documentId` attribute — or, on
 * the paths that have no mark to read (middle click arrives as a DOM event, and
 * a read-only page is rendered HTML), in the anchor's `data-document-id`.
 */
function withLinkIdentity(
  target: LinkTarget,
  mark: PmMark | undefined,
  anchor: HTMLAnchorElement | null,
): LinkTarget {
  if (target.kind !== 'wiki') return target;
  const fromMark = mark?.attrs.documentId;
  const documentId =
    typeof fromMark === 'string' && fromMark.length > 0
      ? fromMark
      : (anchor?.getAttribute('data-document-id') ?? null);
  return documentId === null || documentId.length === 0 ? target : { ...target, documentId };
}

/**
 * Decides whether a click follows a link, and if so, does it.
 *
 * Wired into `editorProps.handleClickOn` (mouse), `handleDOMEvents.click` with
 * `event.detail === 0` (keyboard-activated click) and `handleDOMEvents.auxclick`
 * (middle click, which never produces a `click` event and therefore never
 * reaches `handleClickOn`). See the docstring on `EditorSurface` for why this
 * has to be a plain module function rather than something that closes over
 * component state: `useEditor`'s dependency array must not grow.
 */
function ignoresClick(
  view: EditorView,
  event: MouseEvent,
  anchor: HTMLAnchorElement | null,
): boolean {
  // Left and middle button only: the right button belongs to the context menu,
  // where "Link in neuem Tab öffnen" is the browser's own affair.
  if (event.button !== 0 && event.button !== 1) return true;
  // Alt holds the link still: the caret is meant to land next to it instead.
  if (event.altKey && view.editable) return true;

  const element = event.target instanceof HTMLElement ? event.target : null;
  // The page-link block brings its own click handling (a node view).
  if (element?.closest('[data-page-link]') != null) return true;
  return anchor !== null && !view.dom.contains(anchor);
}

/**
 * Whether this click means "somewhere else", the way it does on every other
 * anchor in the browser: middle click, Strg-/Cmd-click, or an anchor that says
 * `_blank` itself (every external link does, see the Link extension).
 */
function opensInNewTab(event: MouseEvent, anchor: HTMLAnchorElement | null): boolean {
  return event.button === 1 || event.ctrlKey || event.metaKey || anchor?.target === '_blank';
}

function followFromEvent(
  view: EditorView,
  node: PmNode | null,
  event: MouseEvent,
  ref: React.RefObject<FollowLink | null>,
): boolean {
  const element = event.target instanceof HTMLElement ? event.target : null;
  const anchor = element?.closest('a') ?? null;
  if (ignoresClick(view, event, anchor)) return false;

  // Prefers the mark on the clicked text node, falling back to the DOM anchor
  // (table of contents, breadcrumb and media blocks render their own anchors
  // without a `link` mark).
  const mark = node?.marks.find((candidate) => candidate.type.name === 'link');
  const markHref = mark?.attrs.href;
  const href = typeof markHref === 'string' ? markHref : (anchor?.getAttribute('href') ?? null);

  const target = parseLinkHref(href);
  if (target.kind === 'unknown') return false;

  event.preventDefault();
  ref.current?.(withLinkIdentity(target, mark, anchor), {
    download: anchor?.hasAttribute('download') === true,
    newTab: opensInNewTab(event, anchor),
  });
  return true;
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
  workspaceId,
  documentId,
  documentTitle,
  currentUser,
  access,
  breadcrumb,
}: CollaborativeEditorProps) {
  const { connection, error, synced, ready, retry } = useCollaborationConnection({
    documentId,
    documentTitle,
    currentUser,
  });

  if (error !== null) {
    return <ErrorState title="Editor nicht verfügbar" description={error} onRetry={retry} />;
  }
  // `ready`, not just `connection`: an editor built over a document that has
  // not arrived yet leaves an empty paragraph behind on every visit. See
  // `CollaborationConnectionState.ready`.
  if (connection === null || !ready) {
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
  // Marks the blocks that carry an open comment thread. Stateless and stable,
  // like the suggestion plugins above: which blocks are marked is pushed in
  // from `CommentMarkers` in the chrome, never read here.
  const commentMarkers = React.useMemo(() => createCommentMarkers(), []);
  // Marks the `[[Titel]]` references whose target does not exist. Same shape as
  // the comment markers: stateless here, fed from `WikiLinkMarkers` in the
  // chrome.
  const wikiLinkMarkers = React.useMemo(() => createWikiLinkMarkers(), []);

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

  // Same arrangement for the query block (issue #74).
  const askSavedQueryEmbedRef = React.useRef<AskSavedQueryEmbed | null>(null);
  const SavedQueryView = React.useCallback(
    (props: NodeViewProps) => <SavedQueryNodeView {...props} workspaceId={workspaceId} />,
    [workspaceId],
  );

  // Same pattern, for following a link; see `follow-link-context.tsx`.
  const followLinkRef = React.useRef<FollowLink | null>(null);
  // And once more, so a placed page link can be re-targeted; see
  // `page-link-context.tsx`.
  const askPageLinkRef = React.useRef<AskPageLink | null>(null);
  const PageLinkView = React.useCallback(
    (props: NodeViewProps) => <PageLinkNodeView {...props} workspaceId={workspaceId} />,
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
          // The query block: schema in `packages/editor`, live answer here.
          SavedQueryEmbed.extend({ addNodeView: () => ReactNodeViewRenderer(SavedQueryView) }),
          // Same pairing for `pageLink`: the schema stays in `packages/editor`,
          // only its resolution state (icon, path, "does not exist") is React.
          PageLink.extend({ addNodeView: () => ReactNodeViewRenderer(PageLinkView) }),
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
              node.type.name === 'paragraph' ? 'Schreibe etwas oder tippe „/“ für Befehle …' : '',
            // Every empty block gets the hint, not only the first one.
            showOnlyCurrent: true,
            includeChildren: true,
          }),
          slashExtension,
          mentionExtension,
          commentMarkers,
          wikiLinkMarkers,
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
        handleClickOn: (view, _pos, node, _nodePos, event) =>
          followFromEvent(view, node, event, followLinkRef),
        // Keyboard activation (Enter on a focused link) fires a click with
        // `detail === 0` and never reaches `handleClickOn`, which is wired to
        // mousedown/mouseup.
        handleDOMEvents: {
          click: (view, event) =>
            event.detail === 0 ? followFromEvent(view, null, event, followLinkRef) : false,
          // Middle click fires `auxclick`, never `click`, so `handleClickOn`
          // never sees it. Without this a middle click on a link inside a
          // `contenteditable` does nothing at all (issue #29). No node is
          // available here; the DOM anchor carries everything needed.
          auxclick: (view, event) =>
            event.button === 1 ? followFromEvent(view, null, event, followLinkRef) : false,
          // Stops the middle button from starting autoscroll (or pasting the
          // X11 selection) on the link the `auxclick` above is about to open.
          mousedown: (_view, event) => {
            const element = event.target instanceof HTMLElement ? event.target : null;
            if (event.button !== 1 || element?.closest('a') == null) return false;
            event.preventDefault();
            // Not handled: ProseMirror still gets to place the selection.
            return false;
          },
        },
      },
    },
    // `followLinkRef` is a stable ref and `followFromEvent` a module function:
    // neither belongs here. Adding either would rebuild every plugin view on
    // every render, exactly what this component exists to avoid (see above).
    [
      connection.ydoc,
      connection.provider,
      access,
      slashExtension,
      mentionExtension,
      commentMarkers,
      wikiLinkMarkers,
    ],
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
        <SavedQueryEmbedPromptContext.Provider value={askSavedQueryEmbedRef}>
          <PageLinkPromptContext.Provider value={askPageLinkRef}>
            <FollowLinkContext.Provider value={followLinkRef}>
              <EditorContent editor={editor} className="exocortex-editor" />
            </FollowLinkContext.Provider>
          </PageLinkPromptContext.Provider>
        </SavedQueryEmbedPromptContext.Provider>
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
          askSavedQueryEmbedRef={askSavedQueryEmbedRef}
          askPageLinkRef={askPageLinkRef}
          followLinkRef={followLinkRef}
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
  askSavedQueryEmbedRef: React.RefObject<AskSavedQueryEmbed | null>;
  askPageLinkRef: React.RefObject<AskPageLink | null>;
  followLinkRef: React.RefObject<FollowLink | null>;
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
  askSavedQueryEmbedRef,
  askPageLinkRef,
  followLinkRef,
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
  const linkNavigation = useLinkNavigation({ workspaceId });

  // Lets the database embed node view reopen this same picker ("Datenbank
  // wechseln") through the ref `EditorSurface` handed down; see
  // `database-embed-context.tsx`.
  React.useEffect(() => {
    askDatabaseEmbedRef.current = async () => {
      const raw = await prompt.ask('database');
      return raw === null ? null : (JSON.parse(raw) as DatabaseEmbedSelection);
    };
  }, [askDatabaseEmbedRef, prompt]);

  // And for the query block, so "Suche wechseln" reaches the same picker.
  React.useEffect(() => {
    askSavedQueryEmbedRef.current = async () => {
      const raw = await prompt.ask('saved-query');
      return raw === null ? null : (JSON.parse(raw) as SavedQueryEmbedSelection);
    };
  }, [askSavedQueryEmbedRef, prompt]);

  // The same bridge for the page picker, so the `pageLink` node view can
  // re-target a link that is already placed ("Seite ändern") instead of the
  // block having to be deleted and made again; see `page-link-context.tsx`.
  React.useEffect(() => {
    askPageLinkRef.current = async (currentTitle: string) => {
      const raw = await prompt.ask('page', currentTitle);
      return raw === null ? null : (JSON.parse(raw) as PageLinkSelection);
    };
  }, [askPageLinkRef, prompt]);

  // Same bridge for following a link, read by the click handler in
  // `editorProps` and by the `pageLink` node view; see `follow-link-context.tsx`.
  React.useEffect(() => {
    followLinkRef.current = linkNavigation.follow;
  }, [followLinkRef, linkNavigation.follow]);

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
          <SelectionToolbar
            editor={editor}
            catalog={catalog}
            documentId={documentId}
            workspaceId={workspaceId}
          />
          <LinkBubble editor={editor} workspaceId={workspaceId} />
          <CodeBlockToolbar editor={editor} />
          <TableToolbar editor={editor} />
          <BlockHandle editor={editor} catalog={catalog} />
        </>
      ) : null}
      <SlashMenu editor={editor} keyboard={slashKeyboard} catalog={catalog} execute={runEntry} />
      <MentionMenu
        editor={editor}
        keyboard={mentionKeyboard}
        pages={mentionPages}
        users={mentionUsers}
      />
      {/* Renders nothing: it keeps the comment markers in the text in step with
          the panel, in both directions. Read-only pages get them too — a marker
          is a pointer to a discussion, not an editing affordance. */}
      <CommentMarkers editor={editor} documentId={documentId} />
      {/* Renders nothing either: it tells the text which of its `[[Titel]]`
          references point at a page that exists (issue #24). */}
      <WikiLinkMarkers editor={editor} workspaceId={workspaceId} />
      {prompt.element}
      {linkNavigation.element}
    </>
  );
}
