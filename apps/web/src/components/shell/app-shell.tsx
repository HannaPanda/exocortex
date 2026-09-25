'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import * as React from 'react';

import {
  AppBody,
  AppMain,
  AppShell as AppShellFrame,
  cn,
  ResizablePanel,
  Sheet,
  SheetContent,
  SheetTitle,
  SkipToContentLink,
  useIsMobile,
} from '@exocortex/ui';

import { AiSelectionProvider, useAiSelection } from '@/components/ai/ai-selection';
import { CommentAnchorProvider, useCommentAnchor } from '@/components/comments/comment-anchor';
import { LocaleSync } from '@/components/locale-sync';
import { SearchCommand } from '@/components/search/search-command';
import { queryKeys } from '@/lib/api/query-keys';
import { useSessionQuery } from '@/lib/api/session-queries';
import { signOut } from '@/lib/auth/client';
import { isTypingTarget } from '@/lib/keyboard';
import { useRealtime, useRealtimeEvent } from '@/lib/realtime/realtime-provider';
import { usePersistentState } from '@/lib/use-persistent-state';

import { CaptureDialog } from './capture-dialog';
import { ContextPanel } from './context-panel';
import { DocumentSessionProvider } from './document-session';
import { JobProgressIndicator } from './job-progress';
import { PageTree } from './page-tree';
import { shellCommands } from './palette-commands';
import {
  CONTEXT_DEFAULT,
  CONTEXT_STORAGE_KEY,
  type PanelPreference,
  parsePanelPreference,
  SIDEBAR_DEFAULT,
  SIDEBAR_STORAGE_KEY,
} from './panel-preferences';
import { Topbar } from './topbar';
import { TrashSheet } from './trash-sheet';

/**
 * Application shell: header, collapsible navigation, document area and optional
 * context panel. Layout preferences are the only client state that is persisted;
 * everything else is server state owned by TanStack Query.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <DocumentSessionProvider>
      <AiSelectionProvider>
        <CommentAnchorProvider>
          <AppShellInner>{children}</AppShellInner>
        </CommentAnchorProvider>
      </AiSelectionProvider>
    </DocumentSessionProvider>
  );
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const params = useParams<{ workspaceId?: string; documentId?: string }>();
  const session = useSessionQuery();
  const queryClient = useQueryClient();
  const { subscribe } = useRealtime();

  const workspaceId = params.workspaceId ?? null;
  const documentId = params.documentId ?? null;

  // Below the mobile breakpoint, panels overlay the canvas instead of sharing
  // it, so a first-time visitor should not land with one already covering the
  // screen. Returning visitors keep whatever they last chose, on any device.
  const isMobile = useIsMobile();
  const sidebarFallback = React.useMemo<PanelPreference>(
    () => (isMobile ? { ...SIDEBAR_DEFAULT, open: false } : SIDEBAR_DEFAULT),
    [isMobile],
  );
  const contextFallback = React.useMemo<PanelPreference>(
    () => (isMobile ? { ...CONTEXT_DEFAULT, open: false } : CONTEXT_DEFAULT),
    [isMobile],
  );

  // Layout preferences are the only persisted client state.
  const [sidebar, setSidebar] = usePersistentState(
    SIDEBAR_STORAGE_KEY,
    sidebarFallback,
    parsePanelPreference,
  );
  const [context, setContext] = usePersistentState(
    CONTEXT_STORAGE_KEY,
    contextFallback,
    parsePanelPreference,
  );
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [captureOpen, setCaptureOpen] = React.useState(false);
  // The trash used to live inside the page tree, so it existed only while the
  // navigation was open. It is a workspace-wide sheet like the two above.
  const [trashOpen, setTrashOpen] = React.useState(false);

  const sidebarOpen = sidebar.open;
  const contextOpen = context.open;
  const { selection: pendingAiSelection } = useAiSelection();
  const { request: pendingCommentRequest } = useCommentAnchor();
  const setSidebarOpen = React.useCallback(
    (open: boolean) => setSidebar({ ...sidebar, open }),
    [setSidebar, sidebar],
  );
  const setContextOpen = React.useCallback(
    (open: boolean) => setContext({ ...context, open }),
    [context, setContext],
  );

  // Handing a selection to the AI is pointless while the panel is closed: the
  // chip that says what will be sent would be invisible. The ref keys on the
  // hand-over, not on the selection's content, so re-sending the same passage
  // opens the panel again, and a re-render (setContextOpen is not stable) does
  // not re-open a panel the user has since closed.
  const handledSelectionRequest = React.useRef<number | null>(null);
  React.useEffect(() => {
    const requestId = pendingAiSelection?.requestId ?? null;
    if (requestId === null || handledSelectionRequest.current === requestId) return;
    handledSelectionRequest.current = requestId;
    if (!contextOpen) setContextOpen(true);
  }, [pendingAiSelection, contextOpen, setContextOpen]);

  // Same for commenting a passage, and for clicking a marker in the text: the
  // thread lives in the panel, so the panel has to be there to be looked at.
  const handledCommentRequest = React.useRef<number | null>(null);
  React.useEffect(() => {
    const requestId = pendingCommentRequest?.requestId ?? null;
    if (requestId === null || handledCommentRequest.current === requestId) return;
    handledCommentRequest.current = requestId;
    if (!contextOpen) setContextOpen(true);
  }, [pendingCommentRequest, contextOpen, setContextOpen]);

  // Redirect unauthenticated visitors. The API is the source of truth.
  React.useEffect(() => {
    if (session.isError) router.replace('/anmelden');
    if (session.data !== undefined && session.data.user === null) router.replace('/anmelden');
  }, [router, session.data, session.isError]);

  // Subscribe to the workspace room; the server authorizes the subscription.
  React.useEffect(() => {
    if (workspaceId !== null) subscribe(workspaceId);
  }, [subscribe, workspaceId]);

  // Tree-changing events invalidate the tree query for every browser session.
  const invalidateTree = React.useCallback(() => {
    if (workspaceId === null) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.documentTree(workspaceId) });
  }, [queryClient, workspaceId]);

  /**
   * A page changed as a whole: refresh the tree *and* that page itself.
   *
   * The tree alone is not enough. These events also arrive for a change nobody
   * in this browser made — the built-in AI setting a cover it just drew, an MCP
   * client renaming a page, another person archiving one — and the open page
   * would go on showing the stale properties until someone reloaded it.
   */
  const invalidateDocument = React.useCallback(
    (event: { payload: { document: { id: string } } }) => {
      invalidateTree();
      void queryClient.invalidateQueries({
        queryKey: queryKeys.document(event.payload.document.id),
      });
    },
    [invalidateTree, queryClient],
  );

  // A rename or slug change (this browser's own, another member's, or an MCP
  // client's) affects the switcher list and, if open, the settings page.
  useRealtimeEvent('workspace.updated', (event) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetail(event.workspaceId) });
  });
  useRealtimeEvent('document.created', invalidateTree);
  useRealtimeEvent('document.updated', invalidateDocument);
  useRealtimeEvent('document.moved', invalidateTree);
  useRealtimeEvent('document.archived', invalidateDocument);
  useRealtimeEvent('document.restored', invalidateDocument);
  useRealtimeEvent('document.materialized', (event) => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.document(event.payload.documentId),
    });
    // Materializing *any* page rewrites its references, which changes who
    // points at the page currently open. The open page's own key would not
    // catch that, so every cached reference list is invalidated instead.
    void queryClient.invalidateQueries({
      predicate: (query) => query.queryKey[0] === 'document' && query.queryKey[2] === 'links',
    });
  });
  // A saved query was created, edited or deleted, possibly by another member
  // or by an agent. The navigation shows the smart views among them, so every
  // browser in this workspace re-reads the list (issue #74).
  useRealtimeEvent('saved-query.changed', (event) => {
    void queryClient.invalidateQueries({
      queryKey: ['workspace', event.workspaceId, 'saved-queries'],
    });
    void queryClient.invalidateQueries({
      queryKey: ['saved-query', event.payload.savedQueryId],
    });
  });

  // A write from outside the editor (MCP, the built-in AI, the REST endpoint).
  // The text itself arrives through the collaboration socket (ADR-016); what
  // the cache still holds is everything around it, from the version list to the
  // Markdown the context panel reads.
  useRealtimeEvent('document.content.replaced', (event) => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.document(event.payload.documentId),
    });
  });

  // What the palette can do besides finding a page. Built here because this is
  // where the panels and the dialogs live; the palette only lists them.
  const paletteCommands = React.useMemo(
    () =>
      shellCommands({
        hasWorkspace: workspaceId !== null,
        sidebarOpen,
        contextOpen,
        onOpenCapture: () => setCaptureOpen(true),
        onToggleSidebar: () => setSidebarOpen(!sidebarOpen),
        onToggleContext: () => setContextOpen(!contextOpen),
        onOpenTrash: () => setTrashOpen(true),
      }),
    [contextOpen, setContextOpen, setSidebarOpen, sidebarOpen, workspaceId],
  );

  // Global keyboard shortcuts.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
      // Strg+B is the editor's bold, and the editor's keymap runs first: this
      // listener could only add a second action to the same keystroke, never
      // replace it, so the page ended up bold *and* the navigation collapsed
      // (issue #81). Formatting wins where text is being written; everywhere
      // else the key is free.
      // And only where there is a navigation: outside a workspace none is
      // rendered, so the key would swallow the browser's own Strg+B for a
      // panel that cannot appear.
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'b' &&
        workspaceId !== null &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        setSidebarOpen(!sidebarOpen);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === '.') {
        event.preventDefault();
        setContextOpen(!contextOpen);
      }
      // Capture needs a workspace to land in, so outside one the browser keeps
      // its own Strg+E rather than being robbed of it for a dialog that could
      // not do anything (issue #71).
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'e' &&
        workspaceId !== null
      ) {
        event.preventDefault();
        // Opens only, never toggles: closing runs through the dialog, which is
        // what empties its field. Escape is the way out and always was.
        setCaptureOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [contextOpen, setContextOpen, setSidebarOpen, sidebarOpen, workspaceId]);

  return (
    <AppShellFrame>
      <SkipToContentLink />
      <LocaleSync />

      <Topbar
        workspaceId={workspaceId}
        sidebarOpen={sidebarOpen}
        onSidebarOpenChange={setSidebarOpen}
        contextOpen={contextOpen}
        onContextOpenChange={setContextOpen}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenCapture={() => setCaptureOpen(true)}
        onSignOut={() => {
          void signOut().then(() => router.replace('/anmelden'));
        }}
      />

      <AppBody>
        {workspaceId !== null ? (
          isMobile ? (
            <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
              <SheetContent side="left" data-testid="sidebar">
                <SheetTitle className="exocortex-sr-only">Navigation</SheetTitle>
                <nav aria-label="Seitennavigation" className="flex min-h-0 flex-1 flex-col">
                  <PageTree workspaceId={workspaceId} onOpenTrash={() => setTrashOpen(true)} />
                </nav>
              </SheetContent>
            </Sheet>
          ) : sidebarOpen ? (
            <ResizablePanel
              width={sidebar.width}
              onWidthChange={(width) => setSidebar({ ...sidebar, width })}
              handle="right"
              minWidth={200}
              maxWidth={420}
              label="Breite der Navigation"
              className="border-r border-border bg-surface"
              data-testid="sidebar"
            >
              <nav aria-label="Seitennavigation" className="flex min-h-0 flex-1 flex-col">
                <PageTree workspaceId={workspaceId} onOpenTrash={() => setTrashOpen(true)} />
              </nav>
            </ResizablePanel>
          ) : null
        ) : null}

        <AppMain>{children}</AppMain>

        {isMobile ? (
          <Sheet open={contextOpen} onOpenChange={setContextOpen}>
            <SheetContent side="right" data-testid="context-panel">
              <SheetTitle className="exocortex-sr-only">Kontextbereich</SheetTitle>
              <aside aria-label="Kontextbereich" className="flex min-h-0 flex-1 flex-col">
                <ContextPanel workspaceId={workspaceId} documentId={documentId} />
              </aside>
            </SheetContent>
          </Sheet>
        ) : contextOpen ? (
          <ResizablePanel
            width={context.width}
            onWidthChange={(width) => setContext({ ...context, width })}
            handle="left"
            minWidth={260}
            maxWidth={520}
            label="Breite des Kontextbereichs"
            className={cn('border-l border-border bg-surface')}
            data-testid="context-panel"
          >
            <aside aria-label="Kontextbereich" className="flex min-h-0 flex-1 flex-col">
              <ContextPanel workspaceId={workspaceId} documentId={documentId} />
            </aside>
          </ResizablePanel>
        ) : null}
      </AppBody>

      <SearchCommand
        workspaceId={workspaceId}
        open={searchOpen}
        onOpenChange={setSearchOpen}
        commands={paletteCommands}
      />
      {workspaceId === null ? null : (
        <>
          <CaptureDialog
            workspaceId={workspaceId}
            open={captureOpen}
            onOpenChange={setCaptureOpen}
          />
          <TrashSheet workspaceId={workspaceId} open={trashOpen} onOpenChange={setTrashOpen} />
        </>
      )}
      <JobProgressIndicator />
    </AppShellFrame>
  );
}
