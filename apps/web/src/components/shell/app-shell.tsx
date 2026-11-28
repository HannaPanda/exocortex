'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type DocumentSummary, type DocumentTreeResponse } from '@exocortex/contracts';
import {
  AppBody,
  AppMain,
  AppShell as AppShellFrame,
  cn,
  hourCycleOf,
  HourCycleProvider,
  ResizablePanel,
  Sheet,
  SheetContent,
  SheetTitle,
  SkipToContentLink,
  useIsMobile,
} from '@exocortex/ui';

import { AiSelectionProvider, useAiSelection } from '@/components/ai/ai-selection';
import { ChatStartProvider } from '@/components/ai/chat-start';
import { CommentAnchorProvider, useCommentAnchor } from '@/components/comments/comment-anchor';
import { LocaleSync } from '@/components/locale-sync';
import { PaletteContributionsProvider } from '@/components/palette/contributions';
import { PaletteRequestsProvider, useAskPalette } from '@/components/palette/palette-requests';
import { usePaletteCommands } from '@/components/palette/registry';
import { shellCommands } from '@/components/palette/shell-commands';
import { SearchCommand } from '@/components/search/search-command';
import { SettingsDialogProvider } from '@/components/settings-dialog/settings-dialog';
import { useTimeFormatPreference } from '@/lib/api/preferences-queries';
import { queryKeys } from '@/lib/api/query-keys';
import { useSessionQuery } from '@/lib/api/session-queries';
import { shareKeys } from '@/lib/api/share-queries';
import { signOut } from '@/lib/auth/client';
import { SharedDocumentHrefs } from '@/lib/document-href-context';
import { isTypingTarget } from '@/lib/keyboard';
import { useGrantsChanged, useRealtime, useRealtimeEvent } from '@/lib/realtime/realtime-provider';
import { usePersistentState } from '@/lib/use-persistent-state';

import { CaptureDialog } from './capture-dialog';
import { ContextPanel, type ContextPanelProps, type ContextTab } from './context-panel';
import { useDatabaseRealtime } from './database-realtime';
import { useDelegatedWorkRealtime } from './delegated-work-realtime';
import { DocumentSessionProvider } from './document-session';
import { JobProgressIndicator } from './job-progress';
import { PageTree } from './page-tree';
import {
  CONTEXT_DEFAULT,
  CONTEXT_STORAGE_KEY,
  type PanelPreference,
  parsePanelPreference,
  resolveContextWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_STORAGE_KEY,
} from './panel-preferences';
import { SharedNavigation } from './shared-with-me-nav';
import { Topbar } from './topbar';
import { TrashSheet } from './trash-sheet';
import { applyRowEvent, type TreeEvent } from './tree-row-events';
import { useChatScreen } from './use-chat-screen';

/** How long realtime tree events are gathered before the tree is read again. */
const TREE_REFRESH_GATHER_MS = 1000;

/**
 * Application shell: header, collapsible navigation, document area and optional
 * context panel. Layout preferences are the only client state that is persisted;
 * everything else is server state owned by TanStack Query.
 */
/**
 * The account's clock for every time below the shell (issue #255): the
 * palette, the panels and the pages alike.
 */
function AccountHourCycle({ children }: { children: React.ReactNode }) {
  const { format } = useTimeFormatPreference();
  return <HourCycleProvider value={hourCycleOf(format)}>{children}</HourCycleProvider>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AccountHourCycle>
      <DocumentSessionProvider>
        <AiSelectionProvider>
          <CommentAnchorProvider>
            <PaletteRequestsProvider>
              <PaletteContributionsProvider>
                <SettingsDialogProvider>
                  <GrantsRefresh />
                  <ShellDocumentHrefs>
                    <AppShellInner>{children}</AppShellInner>
                  </ShellDocumentHrefs>
                </SettingsDialogProvider>
              </PaletteContributionsProvider>
            </PaletteRequestsProvider>
          </CommentAnchorProvider>
        </AiSelectionProvider>
      </DocumentSessionProvider>
    </AccountHourCycle>
  );
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const t = useTranslations('shell.appShell');
  const tCommands = useTranslations('shell.paletteCommands');
  const router = useRouter();
  const params = useParams<{ workspaceId?: string; documentId?: string }>();
  const session = useSessionQuery();
  const queryClient = useQueryClient();
  const { subscribe } = useRealtime();

  const workspaceId = params.workspaceId ?? null;
  const documentId = params.documentId ?? null;
  // The knowledge map is a room of its own (issue #189): the map fills the left,
  // the assistant the right, and a page tree would be a second, smaller map.
  const pathname = usePathname();
  const immersive = isKnowledgeMapPath(pathname);
  const showNavigation = hasNavigation(pathname, workspaceId) && !immersive;

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
  // Held here rather than in the panel, so the palette can open it at a tab.
  const [contextTab, setContextTab] = React.useState<ContextTab>('ai');
  const askPalette = useAskPalette();

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
  const chatScreen = useChatScreen({
    pathname,
    contextOpen,
    openContext: () => setContextOpen(true),
    showAssistant: () => setContextTab('ai'),
  });
  const chatFillsScreen = chatScreen.fills;
  const changeChatExpanded = chatScreen.change;

  // The row the context panel shares with the page, which is what its upper
  // limit is measured against (issue #246): the shell's body less the
  // navigation beside it.
  const [bodyWidth, measureBody] = useElementWidth();
  const navigationTakes = showNavigation && !isMobile && sidebarOpen ? sidebar.width : 0;
  const contextRoom = bodyWidth === 0 ? 0 : bodyWidth - navigationTakes;

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

  useAssistantBesideMap(immersive, contextOpen, setContextOpen);

  // Redirect unauthenticated visitors. The API is the source of truth.
  React.useEffect(() => {
    if (session.isError) router.replace('/anmelden');
    if (session.data !== undefined && session.data.user === null) router.replace('/anmelden');
  }, [router, session.data, session.isError]);

  // Subscribe to the workspace room; the server authorizes the subscription.
  React.useEffect(() => {
    if (workspaceId !== null) subscribe(workspaceId);
  }, [subscribe, workspaceId]);

  useDocumentTreeRealtime(workspaceId);

  // A rename or slug change (this browser's own, another member's, or an MCP
  // client's) affects the switcher list and, if open, the settings page.
  useRealtimeEvent('workspace.updated', (event) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetail(event.workspaceId) });
  });
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

  // Delegated work, what waits on somebody, and proposals (issues #138, #139, #141).
  useDelegatedWorkRealtime();

  // A row, a column or a view of a database changed elsewhere (issue #254).
  useDatabaseRealtime();

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
  const shellPaletteCommands = React.useMemo(
    () =>
      shellCommands({
        hasWorkspace: workspaceId !== null,
        hasNavigation: showNavigation,
        hasDocument: documentId !== null,
        sidebarOpen,
        contextOpen,
        onOpenCapture: () => setCaptureOpen(true),
        onToggleSidebar: () => setSidebarOpen(!sidebarOpen),
        onToggleContext: () => setContextOpen(!contextOpen),
        onOpenContextTab: (tab) => {
          setContextTab(tab);
          if (!contextOpen) setContextOpen(true);
        },
        chatExpanded: chatFillsScreen,
        onToggleChatExpanded: () => changeChatExpanded(!chatFillsScreen),
        onNewChat: () => {
          setContextTab('ai');
          if (!contextOpen) setContextOpen(true);
          askPalette('new-chat');
        },
        onUndoLastRun: () => {
          setContextTab('ai');
          if (!contextOpen) setContextOpen(true);
          askPalette('undo-last-run');
        },
        onFocus: () => {
          setSidebar({ ...sidebar, open: false });
          setContext({ ...context, open: false });
        },
        onOpenTrash: () => setTrashOpen(true),
        t: tCommands,
      }),
    [
      askPalette,
      changeChatExpanded,
      chatFillsScreen,
      context,
      contextOpen,
      documentId,
      setContext,
      setContextOpen,
      setSidebar,
      setSidebarOpen,
      showNavigation,
      sidebar,
      sidebarOpen,
      tCommands,
      workspaceId,
    ],
  );
  const paletteCommands = usePaletteCommands({
    workspaceId,
    documentId,
    role: session.data?.user?.role ?? 'user',
    shell: shellPaletteCommands,
    open: searchOpen,
  });

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
        showNavigation &&
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
  }, [contextOpen, setContextOpen, setSidebarOpen, showNavigation, sidebarOpen, workspaceId]);

  return (
    // A question typed on the start page: its chat gets the screen, which on
    // a phone is the only size a conversation is comfortable at (issue #288).
    <ChatStartProvider onStart={() => changeChatExpanded(true)}>
      <AppShellFrame>
        <SkipToContentLink />
        <LocaleSync />

        <Topbar
          workspaceId={workspaceId}
          hasNavigation={showNavigation}
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

        <AppBody ref={measureBody}>
          {showNavigation ? (
            isMobile ? (
              <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
                <SheetContent side="left" data-testid="sidebar">
                  <SheetTitle className="exocortex-sr-only">{t('navigationTitle')}</SheetTitle>
                  <nav aria-label={t('pageNavigation')} className="flex min-h-0 flex-1 flex-col">
                    <ShellNavigation workspaceId={workspaceId} setTrashOpen={setTrashOpen} />
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
                label={t('navigationWidth')}
                onReset={() => setSidebar({ ...sidebar, width: SIDEBAR_DEFAULT.width })}
                handleTitle={t('resizeHint')}
                className="border-r border-border bg-surface"
                data-testid="sidebar"
              >
                <nav aria-label={t('pageNavigation')} className="flex min-h-0 flex-1 flex-col">
                  <ShellNavigation workspaceId={workspaceId} setTrashOpen={setTrashOpen} />
                </nav>
              </ResizablePanel>
            ) : null
          ) : null}

          {/* Hidden rather than unmounted while the chat has the screen, so the
            page comes back as it was left: its editor, its scroll position. */}
          <AppMain className={chatFillsScreen && !isMobile ? 'hidden' : undefined}>
            {children}
          </AppMain>

          <ContextArea
            mobile={isMobile}
            open={contextOpen}
            onOpenChange={setContextOpen}
            width={context.width}
            room={contextRoom}
            onWidthChange={(width) => setContext({ ...context, width })}
            onWidthReset={() => setContext({ ...context, width: CONTEXT_DEFAULT.width })}
            chatFillsScreen={chatFillsScreen}
            panel={{
              workspaceId,
              documentId,
              tab: contextTab,
              onTabChange: setContextTab,
              chatExpanded: chatFillsScreen,
              onChatExpandedChange: changeChatExpanded,
            }}
          />
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
    </ChatStartProvider>
  );
}

/**
 * The context panel: a sheet over the page on a phone, a resizable column
 * beside it otherwise. When the chat has the screen (issue #288) the sheet
 * goes full width and the column fills the row.
 */
function ContextArea({
  mobile,
  open,
  onOpenChange,
  width,
  room,
  onWidthChange,
  onWidthReset,
  chatFillsScreen,
  panel,
}: {
  mobile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The remembered width; `room` decides how much of it is drawn. */
  width: number;
  room: number;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  chatFillsScreen: boolean;
  panel: Omit<ContextPanelProps, 'closeButtonInset'>;
}) {
  const t = useTranslations('shell.appShell');
  if (mobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          data-testid="context-panel"
          className={chatFillsScreen ? 'w-full max-w-none border-l-0' : undefined}
        >
          <SheetTitle className="exocortex-sr-only">{t('contextTitle')}</SheetTitle>
          <aside aria-label={t('contextTitle')} className="flex min-h-0 flex-1 flex-col">
            <ContextPanel {...panel} closeButtonInset />
          </aside>
        </SheetContent>
      </Sheet>
    );
  }
  if (!open) return null;
  const sizing = resolveContextWidth(width, room);
  return (
    <ResizablePanel
      width={sizing.width}
      onWidthChange={onWidthChange}
      handle="left"
      minWidth={sizing.min}
      maxWidth={sizing.max}
      label={t('contextWidth')}
      onReset={onWidthReset}
      handleTitle={t('resizeHint')}
      handleTestId="context-panel-resize"
      // A grip wider than its line, reaching into the panel: four pixels are
      // a target for a mouse, not for a finger or a pen. Inwards, because the
      // panel clips; nothing in it scrolls at its left edge.
      handleClassName="z-10 before:absolute before:inset-y-0 before:left-0 before:w-2"
      // The same element either way, so a chat that takes the screen in the
      // middle of an answer keeps streaming it. Filling the row, the
      // remembered width and its handle have nothing to say. Spread only when
      // it applies: `ResizablePanel` sets its width as `style` before the rest
      // of the props, and `style={undefined}` would wipe it.
      {...(chatFillsScreen ? { style: { width: 'auto' } } : {})}
      className={cn(
        'border-l border-border bg-surface',
        chatFillsScreen && 'flex-1 border-l-0 [&>[role=separator]]:hidden',
      )}
      data-testid="context-panel"
    >
      <aside aria-label={t('contextTitle')} className="flex min-h-0 flex-1 flex-col">
        <ContextPanel {...panel} closeButtonInset={false} />
      </aside>
    </ResizablePanel>
  );
}

/**
 * The width of an element, kept current. Read from a ref callback, which runs
 * before the first paint, so a remembered panel width does not jump in a
 * frame after the shell appeared.
 */
function useElementWidth(): [number, (node: HTMLElement | null) => (() => void) | undefined] {
  const [width, setWidth] = React.useState(0);
  const measure = React.useCallback((node: HTMLElement | null) => {
    if (node === null) return undefined;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [width, measure];
}

/**
 * The page events, as the tree and the open page hear them.
 *
 * A page changed as a whole refreshes the tree *and* that page itself. The tree
 * alone is not enough. These events also arrive for a change nobody in this
 * browser made — the built-in AI setting a cover it just drew, an MCP client
 * renaming a page, another person archiving one — and the open page would go
 * on showing the stale properties until someone reloaded it.
 */
function useDocumentTreeRealtime(workspaceId: string | null): void {
  const queryClient = useQueryClient();
  const onTreeEvent = useTreeEvents(workspaceId);
  const onDocumentEvent = React.useCallback(
    (kind: 'updated' | 'archived' | 'restored', document: DocumentSummary) => {
      onTreeEvent({ kind, document });
      void queryClient.invalidateQueries({ queryKey: queryKeys.document(document.id) });
    },
    [onTreeEvent, queryClient],
  );
  useRealtimeEvent('document.created', (event) =>
    onTreeEvent({ kind: 'created', document: event.payload.document }),
  );
  useRealtimeEvent('document.updated', (event) =>
    onDocumentEvent('updated', event.payload.document),
  );
  useRealtimeEvent('document.moved', (event) =>
    onTreeEvent({
      kind: 'moved',
      document: event.payload.document,
      previousParentId: event.payload.previousParentId,
    }),
  );
  useRealtimeEvent('document.archived', (event) =>
    onDocumentEvent('archived', event.payload.document),
  );
  useRealtimeEvent('document.restored', (event) =>
    onDocumentEvent('restored', event.payload.document),
  );
}

/**
 * What a tree-changing event does to this browser's cached trees (issue #221).
 *
 * An event about a database row the sidebar does not show is applied to the
 * sidebar's tree on the spot: its database's row count moves, and nothing is
 * fetched (`applyRowEvent`). Every other event refetches the trees, gathered
 * into one refetch per `TREE_REFRESH_GATHER_MS`, because an agent filling a
 * database sends several events a second and each one used to refetch the
 * whole tree in every open tab. Either way the full tree (only fetched while a
 * page picker is open) and the resolved references are re-read in that same
 * gathered refetch: both name rows. This browser's own changes do not wait:
 * their mutations invalidate the tree themselves.
 */
function useTreeEvents(workspaceId: string | null): (event: TreeEvent) => void {
  const queryClient = useQueryClient();
  const pending = React.useRef<{ timer: ReturnType<typeof setTimeout>; all: boolean } | null>(null);
  // A refresh still gathering belongs to the workspace it was gathered for.
  React.useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current.timer);
      pending.current = null;
    },
    [workspaceId],
  );
  return React.useCallback(
    (event: TreeEvent) => {
      if (workspaceId === null) return;
      const sidebarKey = queryKeys.documentTreeWithRowCounts(workspaceId);
      const sidebar = queryClient.getQueryData<DocumentTreeResponse>(sidebarKey);
      const applied = sidebar === undefined ? null : applyRowEvent(sidebar, event);
      if (applied !== null && applied !== sidebar) queryClient.setQueryData(sidebarKey, applied);

      const all = applied === null;
      if (pending.current !== null) {
        pending.current.all ||= all;
        return;
      }
      pending.current = {
        all,
        timer: setTimeout(() => {
          const refreshAll = pending.current?.all ?? true;
          pending.current = null;
          void queryClient.invalidateQueries({
            queryKey: queryKeys.documentTree(workspaceId),
            // Without rows to learn about, only the tree that names them.
            exact: !refreshAll,
          });
          void queryClient.invalidateQueries({ queryKey: queryKeys.pageLinks(workspaceId) });
        }, TREE_REFRESH_GATHER_MS),
      };
    },
    [queryClient, workspaceId],
  );
}

/**
 * The map is watched while the assistant works, so the assistant opens beside
 * it. Once per arrival: closing it on the map is a choice that stays made.
 */
function useAssistantBesideMap(
  onMap: boolean,
  contextOpen: boolean,
  setContextOpen: (open: boolean) => void,
): void {
  const arrived = React.useRef(false);
  React.useEffect(() => {
    if (!onMap) {
      arrived.current = false;
      return;
    }
    if (arrived.current) return;
    arrived.current = true;
    if (!contextOpen) setContextOpen(true);
  }, [onMap, contextOpen, setContextOpen]);
}

/** `/arbeitsbereich/<id>/karte`, the one route the shell draws without its navigation. */
export function isKnowledgeMapPath(pathname: string | null): boolean {
  return pathname !== null && /^\/arbeitsbereich\/[^/]+\/karte\/?$/.test(pathname);
}

/** The workspace's page tree, or on the shared screens the shared navigation. */
function ShellNavigation({
  workspaceId,
  setTrashOpen,
}: {
  workspaceId: string | null;
  setTrashOpen: (open: boolean) => void;
}) {
  return workspaceId === null ? (
    <SharedNavigation />
  ) : (
    <PageTree workspaceId={workspaceId} onOpenTrash={() => setTrashOpen(true)} />
  );
}

/**
 * Whether the shell draws a navigation column at all: inside a workspace, and
 * on the shared screens. Those belong to no workspace of the reader's, so they
 * have no tree; their navigation is the list of what was shared and the way
 * back into a workspace of one's own (issue #232).
 */
function hasNavigation(pathname: string | null, workspaceId: string | null): boolean {
  return workspaceId !== null || isSharedPath(pathname);
}

/** `/geteilt` and `/geteilt/<id>`: the screens of pages shared with the reader. */
export function isSharedPath(pathname: string | null): boolean {
  return pathname !== null && /^\/geteilt(\/[^/]+)?\/?$/.test(pathname);
}

/**
 * On the shared screens every page link stays in the shared view (issue #327):
 * the editor's links and mentions, the breadcrumb, the overview and the
 * context panel all build `/geteilt/<id>` there instead of the workspace
 * address the reader is refused at. Around the whole shell rather than the
 * page, because the context panel sits beside the page, not inside it.
 */
function ShellDocumentHrefs({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (!isSharedPath(pathname)) return <>{children}</>;
  return <SharedDocumentHrefs>{children}</SharedDocumentHrefs>;
}

/**
 * Reads what was shared with this account again whenever a grant of theirs
 * changed (issue #232, ADR-029). A grantee is in no workspace room, so this
 * notice is the only thing that reaches them: the list in the navigation, the
 * branches unfolded under it, and the shared page that is open all ask the
 * server again, which answers from the grants as they are now.
 */
function GrantsRefresh(): null {
  const queryClient = useQueryClient();
  const documentId = useParams<{ documentId?: string }>().documentId ?? null;
  useGrantsChanged(() => {
    void queryClient.invalidateQueries({ queryKey: shareKeys.incoming() });
    void queryClient.invalidateQueries({ queryKey: shareKeys.branches() });
    if (documentId !== null) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.document(documentId) });
    }
  });
  return null;
}
